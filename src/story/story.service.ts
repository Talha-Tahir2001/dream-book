import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { GeminiService } from '../gemini/gemini.service';
import { ImagenService } from '../gemini/imagen.service';
import { TtsService } from '../gemini/tts.service';
import { PdfService } from '../pdf/pdf.service';
import { FirestoreService } from './firestore.service';
import { CloudTasksService } from './cloud-tasks.service';
import {
  Story,
  StoryRequest,
  StoryPage,
  SseEvent,
  PageTextPayload,
  PageImagePayload,
} from '../shared/schemas';

@Injectable()
export class StoryService {
  private readonly logger = new Logger(StoryService.name);
  private readonly activePipelines = new Set<string>();

  // Always use direct Nano Banana unless Cloud Tasks is explicitly configured
  private get isDirectMode(): boolean {
    const cloudTasksReady = Boolean(
      this.config.get('CLOUD_TASKS_QUEUE') &&
      this.config.get('CLOUD_TASKS_HANDLER_URL'),
    );
    const mode = this.config.get<string>('ILLUSTRATION_MODE', 'direct');
    return mode !== 'tasks' || !cloudTasksReady;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly gemini: GeminiService,
    private readonly imagen: ImagenService,
    private readonly tts: TtsService,
    private readonly pdf: PdfService,
    private readonly firestore: FirestoreService,
    private readonly cloudTasks: CloudTasksService,
  ) {
    this.logger.log(
      `StoryService ready — illustration mode will be determined per-request`,
    );
  }

  async create(userId: string, request: StoryRequest): Promise<Story> {
    const story: Story = {
      id: uuidv4(),
      userId,
      request,
      status: 'pending',
      pages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.firestore.saveStory(story);
    return story;
  }

  generateStream(storyId: string, request: StoryRequest): Observable<SseEvent> {
    const output = new Subject<SseEvent>();

    if (this.activePipelines.has(storyId)) {
      this.logger.warn(
        `Pipeline already running for ${storyId} — ignoring duplicate`,
      );
      setTimeout(() => output.complete(), 100);
      return output.asObservable();
    }

    this.activePipelines.add(storyId);
    const directMode = this.isDirectMode;
    this.logger.log(
      `Starting pipeline for ${storyId} — mode: ${directMode ? 'DIRECT' : 'CLOUD TASKS'}`,
    );

    this.runPipeline(storyId, request, output, directMode)
      .catch((err: Error) => {
        this.logger.error(`Pipeline error for ${storyId}: ${err.message}`);
        output.next({
          event: 'story:error',
          data: { storyId, message: err.message },
        });
        output.complete();
      })
      .finally(() => {
        this.activePipelines.delete(storyId);
      });

    return output.asObservable();
  }

  private async runPipeline(
    storyId: string,
    request: StoryRequest,
    output: Subject<SseEvent>,
    directMode: boolean,
  ): Promise<void> {
    await this.firestore.updateStatus(storyId, 'generating');

    const pages: StoryPage[] = [];
    const ttsPromises: Promise<void>[] = [];
    const illustrationPromises: Promise<void>[] = [];

    // ── Phase 1: Stream text + dispatch jobs ─────────────────
    await new Promise<void>((resolve, reject) => {
      this.gemini.streamStory(storyId, request).subscribe({
        next: (event) => {
          void (async () => {
            try {
              if (event.event === 'page:text') {
                const { pageNumber, text } = event.data as PageTextPayload;
                const page: StoryPage = { pageNumber, text, imagePrompt: '' };
                pages.push(page);
                await this.firestore.upsertPage(storyId, page);

                // Emit text to frontend immediately
                output.next(event);

                // TTS — runs concurrently, emits page:audio when ready
                ttsPromises.push(
                  this.tts
                    .generateAndUpload(
                      text,
                      storyId,
                      pageNumber,
                      request.language,
                    )
                    .then(async (audioUrl) => {
                      page.audioUrl = audioUrl;
                      await this.firestore.upsertPage(storyId, page);
                      output.next({
                        event: 'page:audio',
                        data: { storyId, pageNumber, audioUrl },
                      });
                      this.logger.log(`TTS done: p${pageNumber}`);
                    })
                    .catch((err: Error) =>
                      this.logger.error(
                        `TTS failed p${pageNumber}: ${err.message}`,
                      ),
                    ),
                );
              }

              if (event.event === 'page:image') {
                const { pageNumber, imagePrompt } =
                  event.data as PageImagePayload;
                const page = pages.find((p) => p.pageNumber === pageNumber);
                if (page) {
                  page.imagePrompt = imagePrompt;
                  await this.firestore.upsertPage(storyId, page);
                }

                if (directMode) {
                  // Call Nano Banana directly — emit imageUrl over SSE when ready
                  illustrationPromises.push(
                    this.imagen
                      .generateAndUpload(
                        imagePrompt,
                        storyId,
                        pageNumber,
                        request.illustrationStyle,
                      )
                      .then(async (imageUrl) => {
                        if (page) page.imageUrl = imageUrl;
                        await this.firestore.upsertPage(storyId, {
                          ...(page ?? { pageNumber, text: '', imagePrompt }),
                          imageUrl,
                        });
                        output.next({
                          event: 'page:image',
                          data: { storyId, pageNumber, imageUrl },
                        });
                        this.logger.log(`Illustration done: p${pageNumber}`);
                      })
                      .catch((err: Error) =>
                        this.logger.error(
                          `Imagen failed p${pageNumber}: ${err.message}`,
                        ),
                      ),
                  );
                } else {
                  await this.cloudTasks.dispatchIllustrationJob({
                    storyId,
                    pageNumber,
                    imagePrompt,
                    illustrationStyle: request.illustrationStyle,
                  });
                }
              }

              if (event.event === 'story:complete') resolve();
              if (event.event === 'story:error') {
                reject(new Error((event.data as { message: string }).message));
              }
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        },
        error: reject,
      });
    });

    // ── Phase 2: Wait for TTS + illustrations with timeouts ──
    await this.firestore.updateStatus(storyId, 'illustrating');

    const withTimeout = <T>(
      p: Promise<T>,
      ms: number,
      label: string,
    ): Promise<T> =>
      Promise.race([
        p,
        new Promise<T>((_, rej) =>
          setTimeout(
            () => rej(new Error(`${label} timed out after ${ms}ms`)),
            ms,
          ),
        ),
      ]);

    await Promise.allSettled([
      ...ttsPromises.map((p, i) =>
        withTimeout(p, 90_000, `TTS p${i + 1}`).catch((e: Error) =>
          this.logger.error(`TTS timeout: ${e.message}`),
        ),
      ),
      ...illustrationPromises.map((p, i) =>
        withTimeout(p, 90_000, `Imagen p${i + 1}`).catch((e: Error) =>
          this.logger.error(`Imagen timeout: ${e.message}`),
        ),
      ),
    ]);

    // ── Phase 3: Generate PDF ─────────────────────────────────
    try {
      const story = await this.firestore.getStory(storyId);
      if (story) {
        const pdfUrl = await this.pdf.generate(story);
        await this.firestore.updatePdfUrl(storyId, pdfUrl);
        await this.firestore.updateStatus(storyId, 'complete');
        output.next({
          event: 'story:complete',
          data: { storyId, pageCount: pages.length, pdfUrl },
        });
        this.logger.log(`Story complete: ${storyId} — PDF: ${pdfUrl}`);
      }
    } catch (err) {
      this.logger.error(`PDF failed: ${(err as Error).message}`);
      await this.firestore.updateStatus(storyId, 'complete');
      output.next({
        event: 'story:complete',
        data: { storyId, pageCount: pages.length },
      });
    }

    output.complete();
  }

  async onIllustrationComplete(
    storyId: string,
    pageNumber: number,
    imageUrl: string,
  ): Promise<void> {
    await this.firestore.updatePageImage(storyId, pageNumber, imageUrl);
    const story = await this.firestore.getStory(storyId);
    if (!story) return;
    const allIllustrated =
      story.pages.length > 0 && story.pages.every((p) => p.imageUrl);
    if (allIllustrated) {
      try {
        const pdfUrl = await this.pdf.generate(story);
        await this.firestore.updatePdfUrl(storyId, pdfUrl);
      } catch (err) {
        this.logger.error(`PDF failed: ${(err as Error).message}`);
      }
    }
  }

  async findOne(storyId: string): Promise<Story | null> {
    return this.firestore.getStory(storyId);
  }

  async findByUser(userId: string): Promise<Story[]> {
    return this.firestore.getStoriesByUser(userId);
  }

  async delete(storyId: string): Promise<void> {
    return this.firestore.deleteStory(storyId);
  }
}
