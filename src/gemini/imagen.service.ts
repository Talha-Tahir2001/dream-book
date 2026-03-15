import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenAI,
  Modality,
  type GenerateContentResponse,
} from '@google/genai';
import { GcsService } from '../gcs/gcs.service';

@Injectable()
export class ImagenService {
  private readonly logger = new Logger(ImagenService.name);
  private readonly ai: GoogleGenAI;

  // Nano Banana 2 — Gemini's native image generation via @google/genai SDK.
  // Much simpler than Vertex AI REST calls, no access token needed,
  // and no concurrent request rate limiting issues like Imagen 4.
  constructor(
    private readonly config: ConfigService,
    private readonly gcs: GcsService,
  ) {
    this.ai = new GoogleGenAI({
      apiKey: this.config.getOrThrow<string>('GEMINI_API_KEY'),
    });
  }

  // ──────────────────────────────────────────────────────────
  //  Generate one illustration and upload it to GCS.
  //  Returns a signed GCS URL.
  // ──────────────────────────────────────────────────────────
  async generateAndUpload(
    prompt: string,
    storyId: string,
    pageNumber: number,
    style: string = 'watercolor',
  ): Promise<string> {
    this.logger.log(
      `Generating illustration for story ${storyId} page ${pageNumber}`,
    );

    const fullPrompt = this.buildPrompt(prompt, style);
    const imageBase64 = await this.generateImage(fullPrompt);

    const gcsPath = `stories/${storyId}/page-${pageNumber}.png`;
    const signedUrl = await this.gcs.uploadBase64(
      imageBase64,
      gcsPath,
      'image/png',
    );

    this.logger.log(`Illustration uploaded: ${gcsPath}`);
    return signedUrl;
  }

  // ──────────────────────────────────────────────────────────
  //  Build a rich illustration prompt
  // ──────────────────────────────────────────────────────────
  private buildPrompt(prompt: string, style: string): string {
    const styleGuides: Record<string, string> = {
      watercolor:
        "soft watercolor illustration, children's book style, gentle pastel colors, warm lighting, whimsical and magical atmosphere",
      cartoon:
        "bright cartoon illustration, bold outlines, vibrant flat colors, cheerful and playful, children's book art",
      'pencil-sketch':
        "detailed pencil sketch with soft watercolor wash, charming children's book illustration style",
      'digital-art':
        "vibrant digital illustration, children's book style, clean lines, rich colors, magical and inviting",
    };

    const styleGuide = styleGuides[style] ?? styleGuides.watercolor;

    return [
      prompt,
      `Art style: ${styleGuide}.`,
      'Safe for children, no scary or violent elements.',
      'High quality, detailed, suitable for a printed storybook.',
      'Landscape orientation, 4:3 aspect ratio.',
    ].join(' ');
  }

  // ──────────────────────────────────────────────────────────
  //  Call Nano Banana (gemini-3.1-flash-image-preview) via SDK.
  //  Returns base64-encoded PNG.
  // ──────────────────────────────────────────────────────────
  private async generateImage(prompt: string): Promise<string> {
    const response: GenerateContentResponse =
      await this.ai.models.generateContent({
        model: this.config.getOrThrow<string>('NANO_BANANA_MODEL'),
        contents: prompt,
        config: {
          responseModalities: [Modality.IMAGE, Modality.TEXT],
        },
      });

    const parts = response.candidates?.[0]?.content?.parts ?? [];

    this.logger.debug(
      `Nano Banana parts: ${JSON.stringify(
        parts.map((p) =>
          p.inlineData ? `image/${p.inlineData.mimeType}` : 'text',
        ),
      )}`,
    );

    const imagePart = parts.find((p) =>
      p.inlineData?.mimeType?.startsWith('image/'),
    );

    if (!imagePart?.inlineData?.data) {
      // Log any text response for debugging (model might explain why it didn't generate)
      const textPart = parts.find((p) => p.text);
      if (textPart?.text) {
        this.logger.warn(
          `Nano Banana returned text instead of image: "${textPart.text.substring(0, 200)}"`,
        );
      }
      throw new Error('Nano Banana returned no image data');
    }

    return imagePart.inlineData.data;
  }
}
