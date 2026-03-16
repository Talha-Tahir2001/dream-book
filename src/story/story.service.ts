import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';
import { GeminiService } from '../gemini/gemini.service';
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
import { ConfigService } from '@nestjs/config';
import { ImagenService } from 'src/gemini/imagen.service';

@Injectable()
export class StoryService {
  private readonly logger = new Logger(StoryService.name);
  private readonly isLocalDev: boolean;
  private readonly activePipelines = new Set<string>();
  constructor(
    private readonly gemini: GeminiService,
    private readonly tts: TtsService,
    private readonly pdf: PdfService,
    private readonly firestore: FirestoreService,
    private readonly cloudTasks: CloudTasksService,
    private readonly imagen: ImagenService,
    private readonly config: ConfigService,
  ) {
    this.isLocalDev =
      this.config.get('NODE_ENV', 'development') !== 'production';
    this.logger.log(
      `Illustration mode: ${this.isLocalDev ? 'DIRECT (local dev)' : 'CLOUD TASKS (production)'}`,
    );
  }

  // ──────────────────────────────────────────────────────────
  //  Create a new story record in Firestore
  // ──────────────────────────────────────────────────────────
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

  // ──────────────────────────────────────────────────────────
  //  Core: stream story generation
  //
  //  Flow:
  //  1. Gemini streams interleaved text + image prompts
  //  2. For each page:
  //     a. Persist text to Firestore → emit page:text
  //     b. Dispatch Cloud Tasks job for Imagen → emit page:image (pending)
  //     c. Kick off TTS concurrently → emit page:audio when done
  //  3. When all pages complete → generate PDF → emit story:complete
  // ──────────────────────────────────────────────────────────
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

    const illustrationPromises: Promise<void>[] = [];
    let illustrationIndex = 0;

    // Subscribe to Gemini interleaved stream
    const geminiStream = this.gemini.streamStory(storyId, request);

    await new Promise<void>((resolve, reject) => {
      geminiStream.subscribe({
        next: (event) => {
          void (async () => {
            try {
              if (event.event === 'page:text') {
                const { pageNumber, text } = event.data as PageTextPayload;

                // Save page stub to Firestore
                const page: StoryPage = {
                  pageNumber,
                  text,
                  imagePrompt: '',
                };
                pages.push(page);
                await this.firestore.upsertPage(storyId, page);

                // Forward to SSE
                output.next(event);

                // Start TTS concurrently
                // const ttsJob = this.tts
                //   .generateAndUpload(
                //     text,
                //     storyId,
                //     pageNumber,
                //     request.language,
                //   )
                //   .then(async (audioUrl) => {
                //     page.audioUrl = audioUrl;
                //     await this.firestore.upsertPage(storyId, page);
                //     output.next({
                //       event: 'page:audio',
                //       data: { storyId, pageNumber, audioUrl },
                //     });
                //   })
                //   .catch((err: Error) => {
                //     this.logger.warn(
                //       `TTS failed for page ${pageNumber}: ${err.message}`,
                //     );
                //   });
                // ttsPromises.push(ttsJob);
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
                    .catch((err: Error) =>
                      this.logger.warn(
                        `TTS failed p${pageNumber}: ${err.message}`,
                      ),
                    ),
                );
              }

              if (event.event === 'page:image') {
                const { pageNumber, imagePrompt } =
                  event.data as PageImagePayload;

                // Update image prompt in Firestore
                const page = pages.find((p) => p.pageNumber === pageNumber);
                if (page) {
                  page.imagePrompt = imagePrompt;
                  await this.firestore.upsertPage(storyId, page);
                }

                // Dispatch Cloud Tasks job for Imagen (async)

                // await this.cloudTasks.dispatchIllustrationJob({
                //   storyId,
                //   pageNumber,
                //   imagePrompt,
                //   illustrationStyle: request.illustrationStyle,
                // });

                // Note: page:image with the actual URL will be emitted
                // by InternalController when Cloud Tasks job completes

                if (this.isLocalDev) {
                  // ── Local: call Imagen directly, staggered to avoid rate limits ──
                  const delayMs = illustrationIndex * 3000; // 3s between each call
                  illustrationIndex++;
                  illustrationPromises.push(
                    new Promise<void>((res) => setTimeout(res, delayMs))
                      .then(() =>
                        this.imagen.generateAndUpload(
                          imagePrompt,
                          storyId,
                          pageNumber,
                          request.illustrationStyle,
                        ),
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

              if (event.event === 'story:complete') {
                resolve();
              }

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

    // Wait for all TTS jobs to finish
    await this.firestore.updateStatus(storyId, 'illustrating');
    await Promise.allSettled([...ttsPromises, ...illustrationPromises]);

    // Generate PDF (pages will have text + imageUrl when illustrations done)
    // PDF generation happens in InternalController after all images are ready
    // Here we just mark complete
    // await this.firestore.updateStatus(storyId, 'complete');

    // output.next({
    //   event: 'story:complete',
    //   data: { storyId, pageCount: pages.length },
    // });
    // output.complete();
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

  // ──────────────────────────────────────────────────────────
  //  Called by InternalController after an illustration job completes
  // ──────────────────────────────────────────────────────────
  async onIllustrationComplete(
    storyId: string,
    pageNumber: number,
    imageUrl: string,
  ): Promise<void> {
    await this.firestore.updatePageImage(storyId, pageNumber, imageUrl);

    // Check if all pages now have images → generate PDF
    const story = await this.firestore.getStory(storyId);
    if (!story) return;

    const allIllustrated = story.pages.every((p) => p.imageUrl);
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
