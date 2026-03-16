import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '@nestjs/config';
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
  private readonly isLocalDev: boolean;
  // Prevent duplicate pipelines — tracks in-flight storyIds
  private readonly activePipelines = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly gemini: GeminiService,
    private readonly imagen: ImagenService,
    private readonly tts: TtsService,
    private readonly pdf: PdfService,
    private readonly firestore: FirestoreService,
    private readonly cloudTasks: CloudTasksService,
  ) {
    // ILLUSTRATION_MODE=direct  → call Nano Banana directly (default, works everywhere)
    // ILLUSTRATION_MODE=tasks   → use Cloud Tasks queue (production at scale)
    // Falls back to direct mode if Cloud Tasks vars are missing.
    const mode = this.config.get<string>('ILLUSTRATION_MODE', 'direct');
    const cloudTasksReady = Boolean(
      this.config.get('CLOUD_TASKS_QUEUE') &&
      this.config.get('CLOUD_TASKS_HANDLER_URL'),
    );
    this.isLocalDev = mode !== 'tasks' || !cloudTasksReady;
    this.logger.log(
      `Illustration mode: ${this.isLocalDev ? 'DIRECT (Nano Banana)' : 'CLOUD TASKS'}`,
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

    // Guard against duplicate SSE connections firing the pipeline twice
    if (this.activePipelines.has(storyId)) {
      this.logger.warn(
        `Pipeline already running for ${storyId} — ignoring duplicate stream request`,
      );
      // Return an empty observable; the existing pipeline will emit on Firestore
      setTimeout(() => output.complete(), 100);
      return output.asObservable();
    }

    this.activePipelines.add(storyId);

    this.runPipeline(storyId, request, output)
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
  ): Promise<void> {
    await this.firestore.updateStatus(storyId, 'generating');

    const pages: StoryPage[] = [];
    const ttsPromises: Promise<void>[] = [];

    // ── In local dev: run illustration jobs directly, in parallel ──
    // Nano Banana handles concurrent requests well — no stagger needed.
    const illustrationPromises: Promise<void>[] = [];
    // let illustrationIndex = 0; // kept for potential future stagger if needed

    const geminiStream = this.gemini.streamStory(storyId, request);

    await new Promise<void>((resolve, reject) => {
      geminiStream.subscribe({
        next: (event) => {
          void (async () => {
            try {
              if (event.event === 'page:text') {
                const { pageNumber, text } = event.data as PageTextPayload;

                const page: StoryPage = { pageNumber, text, imagePrompt: '' };
                pages.push(page);
                await this.firestore.upsertPage(storyId, page);
                output.next(event);

                // TTS — fire and forget, emit when done
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
                    })
                    .catch((err: Error) => {
                      this.logger.error(
                        `TTS failed p${pageNumber}: ${err.message}`,
                      );
                      this.logger.error(`TTS error stack: ${err.stack}`);
                    }),
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

                if (this.isLocalDev) {
                  // ── Local: call Nano Banana directly, in parallel ──
                  // illustrationIndex++;
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
                        // Emit page:image NOW with the real URL
                        output.next({
                          event: 'page:image',
                          data: { storyId, pageNumber, imageUrl },
                        });
                        this.logger.log(`Illustration done: p${pageNumber}`);
                      })
                      .catch((err: Error) =>
                        this.logger.warn(
                          `Imagen failed p${pageNumber}: ${err.message}`,
                        ),
                      ),
                  );
                } else {
                  // ── Production: dispatch to Cloud Tasks ──
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
          });
        },
        error: reject,
      });
    });

    await this.firestore.updateStatus(storyId, 'illustrating');

    // Wait for all TTS + (in local dev) all illustrations
    await Promise.allSettled([...ttsPromises, ...illustrationPromises]);

    // Generate PDF once everything is ready
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
      }
    } catch (err) {
      this.logger.error(`PDF generation failed: ${(err as Error).message}`);
      await this.firestore.updateStatus(storyId, 'complete');
      output.next({
        event: 'story:complete',
        data: { storyId, pageCount: pages.length },
      });
    }

    output.complete();
  }

  // Called by InternalController (Cloud Tasks webhook — production only)
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
      this.logger.log(`All pages illustrated for ${storyId} — generating PDF`);
      try {
        const pdfUrl = await this.pdf.generate(story);
        await this.firestore.updatePdfUrl(storyId, pdfUrl);
      } catch (err) {
        this.logger.error(
          `PDF generation failed for ${storyId}: ${(err as Error).message}`,
        );
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
