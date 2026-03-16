import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FirebaseAuthGuard } from '../firebase/firebase-auth.guard';
import { StoryService } from './story.service';
import { StoryRequestSchema } from '../shared/schemas';

@Controller('stories')
@UseGuards(FirebaseAuthGuard)
export class StoryController {
  private readonly logger = new Logger(StoryController.name);

  constructor(private readonly storyService: StoryService) {}

  // ── POST /api/stories ─────────────────────────────────────
  //  Create a story record and return the storyId immediately.
  //  Frontend then opens the SSE stream for /api/stories/:id/stream
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createStory(@Body() body: unknown, @Req() req: Request) {
    const parsed = StoryRequestSchema.safeParse(body);
    if (!parsed.success) {
      return { error: 'Invalid request', details: parsed.error.flatten() };
    }
    const story = await this.storyService.create(req.user!.uid, parsed.data);
    return { storyId: story.id };
  }

  // ── GET /api/stories/:id/stream ───────────────────────────
  //  SSE endpoint — streams page:text, page:image, page:audio,
  //  story:complete events as the story generates
  @Get(':id/stream')
  async streamStory(
    @Param('id') storyId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const story = await this.storyService.findOne(storyId);
    if (!story) throw new NotFoundException('Story not found');
    if (story.userId !== req.user!.uid) throw new ForbiddenException();

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    const write = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 20_000);

    try {
      const observable = this.storyService.generateStream(
        storyId,
        story.request,
      );

      observable.subscribe({
        next: (evt) => write(evt.event, evt.data),
        error: (err: Error) => {
          this.logger.error(`Stream error for ${storyId}: ${err.message}`);
          write('story:error', { storyId, message: err.message });
          clearInterval(keepAlive);
          res.end();
        },
        complete: () => {
          clearInterval(keepAlive);
          res.end();
        },
      });

      req.on('close', () => {
        clearInterval(keepAlive);
      });
    } catch (err) {
      clearInterval(keepAlive);
      write('story:error', { storyId, message: (err as Error).message });
      res.end();
    }
  }

  // ── GET /api/stories ──────────────────────────────────────
  //  List all stories for the authenticated user
  @Get()
  async listStories(@Req() req: Request) {
    const stories = await this.storyService.findByUser(req.user!.uid);
    return { stories };
  }

  // ── GET /api/stories/:id ──────────────────────────────────
  //  Fetch a single completed story (with all page URLs)
  @Get(':id')
  async getStory(@Param('id') storyId: string, @Req() req: Request) {
    const story = await this.storyService.findOne(storyId);
    if (!story) throw new NotFoundException('Story not found');
    if (story.userId !== req.user!.uid) throw new ForbiddenException();
    return story;
  }

  // ── DELETE /api/stories/:id ───────────────────────────────
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteStory(@Param('id') storyId: string, @Req() req: Request) {
    const story = await this.storyService.findOne(storyId);
    if (!story) throw new NotFoundException();
    if (story.userId !== req.user!.uid) throw new ForbiddenException();
    await this.storyService.delete(storyId);
  }
}
