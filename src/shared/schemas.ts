import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
//  Story Request — what the frontend sends to kick off generation
// ─────────────────────────────────────────────────────────────
export const StoryRequestSchema = z.object({
  childName: z.string().min(1).max(50),
  childAge: z.number().int().min(1).max(12),
  interests: z.array(z.string()).min(1).max(5),
  lesson: z.string().max(200).optional(),
  fears: z.array(z.string()).max(3).optional(),
  pageCount: z.number().int().min(4).max(12).default(8),
  illustrationStyle: z
    .enum(['watercolor', 'cartoon', 'pencil-sketch', 'digital-art'])
    .default('watercolor'),
  language: z.string().default('en'),
});

export type StoryRequest = z.infer<typeof StoryRequestSchema>;

// ─────────────────────────────────────────────────────────────
//  Story — persisted to Firestore
// ─────────────────────────────────────────────────────────────
export const StoryStatusSchema = z.enum([
  'pending',
  'generating',
  'illustrating',
  'complete',
  'error',
]);

export type StoryStatus = z.infer<typeof StoryStatusSchema>;

export const StoryPageSchema = z.object({
  pageNumber: z.number(),
  text: z.string(),
  imagePrompt: z.string(),
  imageUrl: z.string().optional(), // GCS signed URL, set after Imagen job
  audioUrl: z.string().optional(), // GCS signed URL for TTS narration
});

export type StoryPage = z.infer<typeof StoryPageSchema>;

export const StorySchema = z.object({
  id: z.string(),
  userId: z.string(),
  request: StoryRequestSchema,
  status: StoryStatusSchema,
  pages: z.array(StoryPageSchema),
  pdfUrl: z.string().optional(),
  createdAt: z.number(), // Unix timestamp ms
  updatedAt: z.number(),
});

export type Story = z.infer<typeof StorySchema>;

// ─────────────────────────────────────────────────────────────
//  SSE Events — streamed from POST /api/stories/:id/stream
//  Frontend listens to these to build the book live
// ─────────────────────────────────────────────────────────────
export type SseEventType =
  | 'story:start' // Generation began, storyId sent
  | 'page:text' // A page's narration text is ready
  | 'page:image' // A page's illustration URL is ready
  | 'page:audio' // A page's TTS audio URL is ready
  | 'story:complete' // All pages done
  | 'story:error'; // Something went wrong

export interface SseEvent<T = unknown> {
  event: SseEventType;
  data: T;
}

export interface StoryStartPayload {
  storyId: string;
}

export interface PageTextPayload {
  storyId: string;
  pageNumber: number;
  text: string;
}

export interface PageImagePayload {
  storyId: string;
  pageNumber: number;
  imageUrl: string;
  imagePrompt: string;
}

export interface PageAudioPayload {
  storyId: string;
  pageNumber: number;
  audioUrl: string;
}

export interface StoryCompletePayload {
  storyId: string;
  pageCount: number;
  pdfUrl?: string;
}

export interface StoryErrorPayload {
  storyId: string;
  message: string;
}

// ─────────────────────────────────────────────────────────────
//  WebSocket Events — for Gemini Live voice input
// ─────────────────────────────────────────────────────────────
export type WsClientEvent =
  | 'voice:start' // Client starts a voice session
  | 'voice:audio' // Raw audio chunk (base64) from mic
  | 'voice:stop'; // Client ends voice session

export type WsServerEvent =
  | 'voice:transcript' // Partial transcript from Gemini Live
  | 'voice:result' // Final StoryRequest extracted from voice
  | 'voice:error';

export interface VoiceAudioPayload {
  sessionId: string;
  audioChunk: string; // base64 PCM 16kHz
}

export interface VoiceTranscriptPayload {
  sessionId: string;
  text: string;
  isFinal: boolean;
}

export interface VoiceResultPayload {
  sessionId: string;
  storyRequest: StoryRequest;
}

// ─────────────────────────────────────────────────────────────
//  Internal — Cloud Tasks job payload
// ─────────────────────────────────────────────────────────────
export const IllustrationJobSchema = z.object({
  storyId: z.string(),
  pageNumber: z.number(),
  imagePrompt: z.string(),
  illustrationStyle: StoryRequestSchema.shape.illustrationStyle,
});

export type IllustrationJob = z.infer<typeof IllustrationJobSchema>;
