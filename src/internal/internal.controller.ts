import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
  Logger,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ImagenService } from '../gemini/imagen.service';
import { StoryService } from '../story/story.service';
import { IllustrationJobSchema } from '../shared/schemas';

@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly imagen: ImagenService,
    private readonly storyService: StoryService,
  ) {}

  // ── POST /api/internal/tasks/illustration ─────────────────
  //  Receives Cloud Tasks HTTP job, generates illustration,
  //  uploads to GCS, updates Firestore.
  //  Returns 200 quickly — Cloud Tasks retries on non-2xx.
  @Post('tasks/illustration')
  @HttpCode(HttpStatus.OK)
  async handleIllustrationJob(
    @Headers('x-internal-secret') secret: string,
    @Body() body: unknown,
  ) {
    // Verify internal secret to prevent unauthorized calls
    const expected = this.config.get<string>('INTERNAL_SECRET', 'dev-secret');
    if (secret !== expected) {
      throw new UnauthorizedException('Invalid internal secret');
    }

    const parsed = IllustrationJobSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.error('Invalid illustration job payload', parsed.error);
      return { ok: false };
    }

    const { storyId, pageNumber, imagePrompt, illustrationStyle } = parsed.data;

    this.logger.log(
      `Processing illustration: story=${storyId} page=${pageNumber}`,
    );

    try {
      const imageUrl = await this.imagen.generateAndUpload(
        imagePrompt,
        storyId,
        pageNumber,
        illustrationStyle,
      );

      await this.storyService.onIllustrationComplete(
        storyId,
        pageNumber,
        imageUrl,
      );

      this.logger.log(
        `Illustration complete: story=${storyId} page=${pageNumber}`,
      );
      return { ok: true, imageUrl };
    } catch (err) {
      this.logger.error(
        `Illustration failed: story=${storyId} page=${pageNumber}: ${(err as Error).message}`,
      );
      // Return 500 so Cloud Tasks retries the job
      throw err;
    }
  }
}
