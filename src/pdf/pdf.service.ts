import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { GcsService } from '../gcs/gcs.service';
import { Story } from '../shared/schemas';

// A4 landscape — 842 x 595 pt
const PAGE_WIDTH = 842;
const PAGE_HEIGHT = 595;
const MARGIN = 40;
const IMAGE_WIDTH = PAGE_WIDTH / 2 - MARGIN * 1.5;
const IMAGE_HEIGHT = PAGE_HEIGHT - MARGIN * 2;
const TEXT_X = PAGE_WIDTH / 2 + MARGIN / 2;
const TEXT_WIDTH = PAGE_WIDTH / 2 - MARGIN * 1.5;

// Strip characters that WinAnsi (pdf-lib default) cannot encode.
// This covers emoji, smart quotes, and other non-Latin-1 characters.
function safeText(text: string): string {
  return text
    .replace(/[^\x00-\xFF]/g, '') // remove anything outside Latin-1 range
    .replace(/\u2018|\u2019/g, "'") // smart single quotes → apostrophe
    .replace(/\u201C|\u201D/g, '"') // smart double quotes → straight quote
    .replace(/\u2014/g, '--') // em dash → double hyphen
    .replace(/\u2013/g, '-') // en dash → hyphen
    .replace(/\u2026/g, '...') // ellipsis → three dots
    .trim();
}

@Injectable()
export class PdfService {
  private readonly logger = new Logger(PdfService.name);

  constructor(private readonly gcs: GcsService) {}

  async generate(story: Story): Promise<string> {
    this.logger.log(`Generating PDF for story ${story.id}`);

    const pdfDoc = await PDFDocument.create();

    await this.addCoverPage(pdfDoc, story);

    for (const page of story.pages) {
      await this.addStoryPage(pdfDoc, page.text, page.imageUrl);
    }

    const pdfBytes = await pdfDoc.save();
    const buffer = Buffer.from(pdfBytes);

    const gcsPath = `stories/${story.id}/storybook.pdf`;
    const signedUrl = await this.gcs.uploadBuffer(
      buffer,
      gcsPath,
      'application/pdf',
    );

    this.logger.log(`PDF uploaded: ${gcsPath}`);
    return signedUrl;
  }

  private async addCoverPage(pdfDoc: PDFDocument, story: Story): Promise<void> {
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const bodyFont = await pdfDoc.embedFont(StandardFonts.Helvetica);

    page.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      color: rgb(0.98, 0.96, 0.9),
    });

    // Decorative top bar
    page.drawRectangle({
      x: 0,
      y: PAGE_HEIGHT - 8,
      width: PAGE_WIDTH,
      height: 8,
      color: rgb(0.85, 0.75, 0.45),
    });

    // Child's name title — safeText strips emoji
    const title = safeText(`${story.request.childName}'s Storybook`);
    const titleSize = 38;
    const titleWidth = font.widthOfTextAtSize(title, titleSize);
    page.drawText(title, {
      x: (PAGE_WIDTH - titleWidth) / 2,
      y: PAGE_HEIGHT / 2 + 30,
      size: titleSize,
      font,
      color: rgb(0.2, 0.15, 0.35),
    });

    // Subtitle — no emoji
    const subtitle = safeText('A personalized adventure made with DreamBook');
    const subSize = 14;
    const subWidth = bodyFont.widthOfTextAtSize(subtitle, subSize);
    page.drawText(subtitle, {
      x: (PAGE_WIDTH - subWidth) / 2,
      y: PAGE_HEIGHT / 2 - 20,
      size: subSize,
      font: bodyFont,
      color: rgb(0.5, 0.45, 0.6),
    });

    // Interests line
    if (story.request.interests.length > 0) {
      const interests = safeText(story.request.interests.join('  |  '));
      const intWidth = bodyFont.widthOfTextAtSize(interests, 12);
      page.drawText(interests, {
        x: (PAGE_WIDTH - intWidth) / 2,
        y: PAGE_HEIGHT / 2 - 55,
        size: 12,
        font: bodyFont,
        color: rgb(0.65, 0.6, 0.5),
      });
    }
  }

  private async addStoryPage(
    pdfDoc: PDFDocument,
    text: string,
    imageUrl?: string,
  ): Promise<void> {
    const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    page.drawRectangle({
      x: 0,
      y: 0,
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
      color: rgb(0.98, 0.96, 0.9),
    });

    // Image — left half
    if (imageUrl) {
      try {
        const imageBytes = await this.fetchImageBytes(imageUrl);
        const image = await pdfDoc
          .embedPng(imageBytes)
          .catch(async () => pdfDoc.embedJpg(imageBytes));
        page.drawImage(image, {
          x: MARGIN,
          y: MARGIN,
          width: IMAGE_WIDTH,
          height: IMAGE_HEIGHT,
        });
      } catch (err) {
        this.logger.warn(`Could not embed image: ${(err as Error).message}`);
        page.drawRectangle({
          x: MARGIN,
          y: MARGIN,
          width: IMAGE_WIDTH,
          height: IMAGE_HEIGHT,
          color: rgb(0.9, 0.88, 0.85),
        });
      }
    } else {
      // Placeholder when illustration wasn't ready
      page.drawRectangle({
        x: MARGIN,
        y: MARGIN,
        width: IMAGE_WIDTH,
        height: IMAGE_HEIGHT,
        color: rgb(0.93, 0.91, 0.88),
      });
    }

    // Text — right half, sanitized
    const safeStoryText = safeText(text);
    const fontSize = 14;
    const lineHeight = fontSize * 1.65;
    const words = safeStoryText.split(' ').filter(Boolean);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      try {
        const width = font.widthOfTextAtSize(testLine, fontSize);
        if (width > TEXT_WIDTH) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          currentLine = testLine;
        }
      } catch {
        // Skip word if it contains unencodable chars that slipped through
        continue;
      }
    }
    if (currentLine) lines.push(currentLine);

    const totalTextHeight = lines.length * lineHeight;
    const startY = (PAGE_HEIGHT + totalTextHeight) / 2;

    lines.forEach((line, i) => {
      try {
        page.drawText(line, {
          x: TEXT_X,
          y: startY - i * lineHeight,
          size: fontSize,
          font,
          color: rgb(0.15, 0.12, 0.25),
          maxWidth: TEXT_WIDTH,
        });
      } catch {
        // Skip line on encoding error rather than crashing the whole PDF
        this.logger.warn(
          `Skipped unencodable line in PDF: "${line.substring(0, 30)}..."`,
        );
      }
    });
  }

  private async fetchImageBytes(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Failed to fetch image: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }
}
