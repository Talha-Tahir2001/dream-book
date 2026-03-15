import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import { GcsService } from '../gcs/gcs.service';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);
  private readonly ai: GoogleGenAI;

  constructor(
    private readonly config: ConfigService,
    private readonly gcs: GcsService,
  ) {
    this.ai = new GoogleGenAI({
      apiKey: this.config.getOrThrow<string>('GEMINI_API_KEY'),
    });
  }

  // ──────────────────────────────────────────────────────────
  //  Generate narration for one story page and upload to GCS.
  //  Returns a signed GCS URL.
  //
  //  Uses generateContent with responseModalities: ['AUDIO']
  //  which is simpler and more reliable than the Live API for
  //  non-realtime single-shot TTS generation.
  // ──────────────────────────────────────────────────────────
  async generateAndUpload(
    text: string,
    storyId: string,
    pageNumber: number,
    language: string = 'en',
  ): Promise<string> {
    this.logger.log(`Generating TTS for story ${storyId} page ${pageNumber}`);

    const pcmBase64 = await this.synthesize(text, language);
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');

    // TTS model returns raw PCM — wrap in WAV for browser playback
    const wavBuffer = this.pcmToWav(pcmBuffer, 24000, 1, 16);

    const gcsPath = `stories/${storyId}/audio-page-${pageNumber}.wav`;
    const signedUrl = await this.gcs.uploadBuffer(
      wavBuffer,
      gcsPath,
      'audio/wav',
    );

    this.logger.log(`TTS uploaded: ${gcsPath}`);
    return signedUrl;
  }

  private async synthesize(text: string, language: string): Promise<string> {
    const languageInstruction =
      language !== 'en'
        ? `Narrate the following in ${language} language. `
        : '';

    const response: GenerateContentResponse =
      await this.ai.models.generateContent({
        model: this.config.getOrThrow<string>('TTS_MODEL'),
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${languageInstruction}Read the following children's story page aloud in a warm, gentle, expressive storytelling voice. Speak slowly and soothingly as if narrating a bedtime story. Read exactly what is written:\n\n"${text}"`,
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Kore' },
            },
          },
        },
      });

    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    this.logger.debug(
      `TTS parts: ${JSON.stringify(parts.map((p) => p.inlineData?.mimeType ?? 'text'))}`,
    );

    const audioPart = parts.find((p) =>
      p.inlineData?.mimeType?.startsWith('audio/'),
    );

    if (!audioPart?.inlineData?.data) {
      throw new Error('TTS model returned no audio data');
    }

    const mimeType = audioPart.inlineData.mimeType ?? '';
    this.logger.log(`TTS audio mimeType: ${mimeType}`);

    // Handle both PCM and pre-encoded formats
    if (!mimeType.includes('pcm') && !mimeType.includes('l16')) {
      // Already encoded (mp3, wav, ogg) — upload directly
      return audioPart.inlineData.data;
    }

    return audioPart.inlineData.data; // raw PCM — will be wrapped in WAV below
  }

  // ──────────────────────────────────────────────────────────
  //  Wrap raw 16-bit signed little-endian PCM in a WAV header.
  //  Gemini TTS outputs 24kHz mono PCM.
  // ──────────────────────────────────────────────────────────
  private pcmToWav(
    pcm: Buffer,
    sampleRate: number,
    channels: number,
    bitDepth: number,
  ): Buffer {
    const byteRate = (sampleRate * channels * bitDepth) / 8;
    const blockAlign = (channels * bitDepth) / 8;
    const dataSize = pcm.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitDepth, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcm]);
  }
}
