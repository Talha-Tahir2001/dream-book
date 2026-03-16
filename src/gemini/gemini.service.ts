import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable, Subject } from 'rxjs';
import { StoryRequest, StoryPage, SseEvent } from '../shared/schemas';
import { GoogleGenAI } from '@google/genai';

// Regex to detect Gemini's inline image directives in interleaved output
// e.g. [IMAGE: a young girl riding a purple dinosaur through a glowing forest]
const IMAGE_DIRECTIVE_RE = /\[IMAGE:\s*([^\]]+)\]/gi;

@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);

  constructor(private readonly config: ConfigService) {}

  // ──────────────────────────────────────────────────────────
  //  Build the master story prompt
  // ──────────────────────────────────────────────────────────
  private buildStoryPrompt(req: StoryRequest): string {
    const interestsList = req.interests.join(', ');
    const fearsList = req.fears?.join(', ') ?? 'none';
    const lessonText = req.lesson
      ? `The story should teach this lesson: "${req.lesson}".`
      : '';

    return `
You are a master children's book author and creative director.

Write a personalized storybook for a child with these details:
- Name: ${req.childName}
- Age: ${req.childAge}
- Interests: ${interestsList}
- Fears to gently address: ${fearsList}
- ${lessonText}

STRICT OUTPUT FORMAT:
- Write exactly ${req.pageCount} pages.
- Each page must have 2-4 sentences of narrative text appropriate for age ${req.childAge}.
- After each page's text, insert an image directive on its own line in EXACTLY this format:
  [IMAGE: <detailed illustration prompt in ${req.illustrationStyle} style, featuring ${req.childName}, vivid and child-friendly>]
- Language: ${req.language}
- Do NOT add titles, page numbers, or any other text. Just narrative + [IMAGE:] directives.

Begin the story now:
`.trim();
  }

  // ──────────────────────────────────────────────────────────
  //  Stream story generation — emits SSE-compatible events
  //  as Gemini streams its interleaved output.
  //
  //  Consumers iterate the returned Observable and forward
  //  events to the HTTP SSE response.
  // ──────────────────────────────────────────────────────────
  streamStory(storyId: string, req: StoryRequest): Observable<SseEvent> {
    const subject = new Subject<SseEvent>();

    // Run async in background — don't block caller
    this.runGeneration(storyId, req, subject).catch((err: Error) => {
      this.logger.error(`Generation failed for ${storyId}: ${err.message}`);
      subject.next({
        event: 'story:error',
        data: { storyId, message: err.message },
      });
      subject.complete();
    });

    return subject.asObservable();
  }

  // ──────────────────────────────────────────────────────────
  //  Internal: consume the Gemini stream and parse pages
  // ──────────────────────────────────────────────────────────
  private async runGeneration(
    storyId: string,
    req: StoryRequest,
    subject: Subject<SseEvent>,
  ): Promise<void> {
    const prompt = this.buildStoryPrompt(req);

    this.logger.log(`Starting generation for story ${storyId}`);

    const genAI = new GoogleGenAI({
      apiKey: this.config.getOrThrow<string>('GEMINI_API_KEY'),
      vertexai: true,
    });

    const streamResult = genAI.models.generateContentStream({
      model: this.config.getOrThrow<string>(
        'GEMINI_MODEL',
        'gemini-2.0-flash-exp',
      ),
      contents: prompt,
    });

    // const streamResult: GenerateContentStreamResult =
    //   await this.model.generateContentStream(prompt);

    let pageNumber = 0;
    let pageTextBuffer = '';
    // let fullText = '';

    for await (const chunk of await streamResult) {
      // const chunkText = chunk.text ?? '';
      // //   fullText += chunkText;
      // pageTextBuffer += chunkText;

      // // Check if we've accumulated a complete page
      // // A page ends when we find a [IMAGE: ...] directive
      // const imageMatch = IMAGE_DIRECTIVE_RE.exec(pageTextBuffer);

      // if (imageMatch) {
      //   pageNumber++;
      //   const imagePrompt = imageMatch[1].trim();

      //   // Extract just the narrative text (before the [IMAGE:] tag)
      //   const narrativeText = pageTextBuffer
      //     .slice(0, imageMatch.index)
      //     .trim()
      //     .replace(/\n{3,}/g, '\n\n');
      // In @google/genai SDK, extract text from the first candidate's parts
      const candidate = chunk.candidates?.[0];
      const chunkText =
        candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      pageTextBuffer += chunkText;

      const imageMatch = IMAGE_DIRECTIVE_RE.exec(pageTextBuffer);
      if (imageMatch) {
        pageNumber++;
        const imagePrompt = imageMatch[1].trim();
        const narrativeText = pageTextBuffer
          .slice(0, imageMatch.index)
          .trim()
          .replace(/\n{3,}/g, '\n\n');

        // Emit page text
        subject.next({
          event: 'page:text',
          data: { storyId, pageNumber, text: narrativeText },
        });

        // Emit image prompt so the backend can dispatch an illustration job
        // (StoryService handles the actual Imagen call)
        subject.next({
          event: 'page:image',
          data: { storyId, pageNumber, imagePrompt },
        });

        // Reset buffer — keep anything after the [IMAGE:] tag for next page
        pageTextBuffer = pageTextBuffer.slice(
          imageMatch.index + imageMatch[0].length,
        );

        // Reset regex lastIndex since we're reusing the global regex
        IMAGE_DIRECTIVE_RE.lastIndex = 0;
      }
    }

    // Flush any remaining text as a final page (shouldn't normally happen)
    if (pageTextBuffer.trim() && pageNumber < req.pageCount) {
      pageNumber++;
      subject.next({
        event: 'page:text',
        data: { storyId, pageNumber, text: pageTextBuffer.trim() },
      });
    }

    this.logger.log(`Generation complete for ${storyId} — ${pageNumber} pages`);
    subject.next({
      event: 'story:complete',
      data: { storyId, pageCount: pageNumber },
    });
    subject.complete();
  }

  // ──────────────────────────────────────────────────────────
  //  Parse raw Gemini output into StoryPage array
  //  Used when re-processing a completed story
  // ──────────────────────────────────────────────────────────
  parsePages(
    rawText: string,
  ): Pick<StoryPage, 'pageNumber' | 'text' | 'imagePrompt'>[] {
    const pages: Pick<StoryPage, 'pageNumber' | 'text' | 'imagePrompt'>[] = [];
    const segments = rawText.split(IMAGE_DIRECTIVE_RE);
    // After split with a capturing group: [text0, prompt1, text1, prompt2, ...]
    for (let i = 0; i < segments.length - 1; i += 2) {
      const text = segments[i].trim();
      const imagePrompt = segments[i + 1]?.trim();
      if (text && imagePrompt) {
        pages.push({ pageNumber: pages.length + 1, text, imagePrompt });
      }
    }
    return pages;
  }
}
