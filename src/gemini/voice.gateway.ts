import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { ConfigService } from '@nestjs/config';
import {
  GoogleGenAI,
  Modality,
  type LiveConnectConfig,
  type Session as LiveSession,
  type LiveServerMessage,
} from '@google/genai';
import { StoryRequest, StoryRequestSchema } from '../shared/schemas';

// ── Typed payloads ────────────────────────────────────────────

interface VoiceAudioPayload {
  audioChunk: string; // base64 PCM 16kHz mono
}

interface VoiceTranscriptEvent {
  sessionId: string;
  text: string;
  isFinal: boolean;
}

interface VoiceErrorEvent {
  sessionId: string;
  message: string;
}

// ── Per-socket session state ──────────────────────────────────

interface VoiceSession {
  readonly socketId: string;
  liveSession: LiveSession | null;
  transcript: string; // accumulated final transcript text
}

@WebSocketGateway({
  cors: { origin: '*' },
  namespace: '/voice',
})
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;

  private readonly logger = new Logger(VoiceGateway.name);
  private readonly ai: GoogleGenAI;
  private readonly sessions = new Map<string, VoiceSession>();

  constructor(private readonly config: ConfigService) {
    this.ai = new GoogleGenAI({
      apiKey: this.config.getOrThrow<string>('GEMINI_API_KEY'),
    });
  }

  // ── Socket lifecycle ────────────────────────────────────────

  handleConnection(socket: Socket): void {
    this.logger.log(`Client connected: ${socket.id}`);
    this.sessions.set(socket.id, {
      socketId: socket.id,
      liveSession: null,
      transcript: '',
    });
  }

  handleDisconnect(socket: Socket): void {
    this.logger.log(`Client disconnected: ${socket.id}`);
    const session = this.sessions.get(socket.id);
    if (session?.liveSession) {
      try {
        session.liveSession.close();
      } catch {
        /* already closed */
      }
    }
    this.sessions.delete(socket.id);
  }

  // ── voice:start ─────────────────────────────────────────────
  @SubscribeMessage('voice:start')
  async handleVoiceStart(@ConnectedSocket() socket: Socket): Promise<void> {
    const session = this.sessions.get(socket.id);
    if (!session) return;

    if (session.liveSession) {
      try {
        session.liveSession.close();
      } catch {
        /* ignore */
      }
      session.liveSession = null;
    }
    session.transcript = '';

    this.logger.log(`Voice session started: ${socket.id}`);

    try {
      const liveConfig: LiveConnectConfig = {
        responseModalities: [Modality.AUDIO],
        // Enable real-time transcription of user speech
        inputAudioTranscription: {},
        systemInstruction: {
          parts: [
            {
              text: 'You are a transcription assistant. A parent is describing their child for a personalized storybook. Listen carefully and do not respond — just transcribe what is said.',
            },
          ],
        },
      };

      const liveSession = await this.ai.live.connect({
        model: this.config.getOrThrow<string>('LIVE_MODEL'),
        config: liveConfig,
        callbacks: {
          onopen: (): void => {
            this.logger.log(`Live session open: ${socket.id}`);
          },

          onmessage: (e: LiveServerMessage): void => {
            this.handleLiveMessage(socket, session, e);
          },

          onerror: (e: ErrorEvent): void => {
            this.logger.error(`Live error for ${socket.id}: ${e.message}`);
            this.emitError(socket, 'Voice connection error. Please try again.');
          },

          onclose: (e: CloseEvent): void => {
            this.logger.log(
              `Live session closed for ${socket.id}: ${e.reason || 'normal'}`,
            );
          },
        },
      });

      session.liveSession = liveSession;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to open Live session for ${socket.id}: ${msg}`);
      this.emitError(
        socket,
        'Could not start voice session. Please try again.',
      );
    }
  }

  // ── voice:audio ─────────────────────────────────────────────
  @SubscribeMessage('voice:audio')
  handleVoiceAudio(
    @ConnectedSocket() socket: Socket,
    @MessageBody() payload: VoiceAudioPayload,
  ): void {
    const session = this.sessions.get(socket.id);
    if (!session?.liveSession) return;

    try {
      session.liveSession.sendRealtimeInput({
        audio: {
          data: payload.audioChunk,
          mimeType: 'audio/pcm;rate=16000',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Audio send error for ${socket.id}: ${msg}`);
    }
  }

  // ── voice:stop ──────────────────────────────────────────────
  @SubscribeMessage('voice:stop')
  async handleVoiceStop(@ConnectedSocket() socket: Socket): Promise<void> {
    const session = this.sessions.get(socket.id);
    if (!session) return;

    if (session.liveSession) {
      try {
        session.liveSession.close();
      } catch {
        /* ignore */
      }
      session.liveSession = null;
    }

    const transcript = session.transcript.trim();
    this.logger.log(`Extracting story from transcript: "${transcript}"`);

    if (!transcript) {
      this.emitError(socket, 'No speech detected. Please try again.');
      return;
    }

    this.emitTranscript(socket, transcript, true);

    try {
      const storyRequest = await this.extractStoryRequest(transcript);
      socket.emit('voice:result', { sessionId: socket.id, storyRequest });
      session.transcript = '';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Story extraction failed for ${socket.id}: ${msg}`);
      this.emitError(
        socket,
        'Could not understand the description. Please try again.',
      );
    }
  }

  // ── Handle Live API messages ─────────────────────────────────
  private handleLiveMessage(
    socket: Socket,
    session: VoiceSession,
    message: LiveServerMessage,
  ): void {
    // Log the full message shape in debug mode to diagnose transcription issues
    this.logger.debug(
      `Live message for ${socket.id}: ${JSON.stringify(message).substring(0, 300)}`,
    );

    const content = message.serverContent;
    if (!content) return;

    // ── inputTranscription — real-time transcription of user speech ──
    if (content.inputTranscription) {
      const chunk = content.inputTranscription.text ?? '';
      const finished = content.inputTranscription.finished ?? false;

      this.logger.log(
        `Transcription chunk for ${socket.id}: "${chunk}" (finished: ${finished})`,
      );

      if (chunk) {
        // IMPORTANT: The native audio model often never sends finished:true.
        // Accumulate ALL chunks into the transcript continuously.
        session.transcript += (session.transcript ? '' : '') + chunk;

        this.emitTranscript(socket, session.transcript.trim(), false);
      }
    }

    // ── outputTranscription — Gemini's own speech (discard for voice input flow) ──
    // ── modelTurn text — fallback if model responds in text ──────────────────────
    // (shouldn't happen with our system instruction, but accumulate as fallback)
    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.text && !session.transcript) {
          this.logger.warn(
            `Model responded with text (expected transcription only): "${part.text.substring(0, 100)}"`,
          );
        }
      }
    }
  }

  // ── Typed emit helpers ────────────────────────────────────────

  private emitTranscript(socket: Socket, text: string, isFinal: boolean): void {
    socket.emit('voice:transcript', {
      sessionId: socket.id,
      text,
      isFinal,
    } satisfies VoiceTranscriptEvent);
  }

  private emitError(socket: Socket, message: string): void {
    socket.emit('voice:error', {
      sessionId: socket.id,
      message,
    } satisfies VoiceErrorEvent);
  }

  // ── extractStoryRequest ───────────────────────────────────────
  private async extractStoryRequest(transcript: string): Promise<StoryRequest> {
    const response = await this.ai.models.generateContent({
      model: this.config.getOrThrow<string>('GEMINI_MODEL'),
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `
You are extracting story parameters from a parent describing their child for a personalized storybook.

Parent said: "${transcript}"

Return ONLY a raw JSON object — no markdown, no code fences, no explanation.

Required fields:
{
  "childName": "string — child's first name, or 'Your Child' if not mentioned",
  "childAge": 5,
  "interests": ["at least one string — infer from context if not explicit"],
  "pageCount": 8,
  "illustrationStyle": "watercolor",
  "language": "en"
}

Optional fields — include ONLY if clearly mentioned, otherwise OMIT entirely (never use null):
  "lesson": "string — what the parent wants the child to learn",
  "fears": ["string — things the child is afraid of"]

Rules:
- NEVER output null for any field.
- interests must have at least 1 item. If unclear, use ["adventure"].
- childAge must be a number 1–12. Default 5 if not mentioned.
- Return raw JSON only. No backticks.
`,
            },
          ],
        },
      ],
    });

    const raw = (response.text ?? '')
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    this.logger.debug(`Extraction output: ${raw}`);

    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const sanitized: Record<string, unknown> = {
      childName:
        typeof parsed.childName === 'string' && parsed.childName
          ? parsed.childName
          : 'Your Child',
      childAge:
        typeof parsed.childAge === 'number'
          ? Math.min(12, Math.max(1, Math.round(parsed.childAge)))
          : 5,
      interests:
        Array.isArray(parsed.interests) && parsed.interests.length > 0
          ? (parsed.interests as unknown[]).map(String)
          : ['adventure'],
      pageCount: 8,
      illustrationStyle:
        typeof parsed.illustrationStyle === 'string'
          ? parsed.illustrationStyle
          : 'watercolor',
      language: typeof parsed.language === 'string' ? parsed.language : 'en',
    };

    if (typeof parsed.lesson === 'string' && parsed.lesson) {
      sanitized.lesson = parsed.lesson;
    }
    if (Array.isArray(parsed.fears) && parsed.fears.length > 0) {
      sanitized.fears = (parsed.fears as unknown[]).map(String);
    }

    return StoryRequestSchema.parse(sanitized);
  }
}
