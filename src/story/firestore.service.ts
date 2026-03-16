import { Injectable, Logger } from '@nestjs/common';
import { FirebaseService } from '../firebase/firebase.service';
import { Story, StoryPage, StoryStatus } from '../shared/schemas';

const STORIES_COLLECTION = 'stories';

@Injectable()
export class FirestoreService {
  private readonly logger = new Logger(FirestoreService.name);

  constructor(private readonly firebase: FirebaseService) {}

  private get db() {
    this.logger.log('FirestoreService initialized');
    return this.firebase.firestore;
  }

  async saveStory(story: Story): Promise<void> {
    await this.db.collection(STORIES_COLLECTION).doc(story.id).set(story);
    this.logger.log(`Saved story ${story.id}`);
  }

  async getStory(storyId: string): Promise<Story | null> {
    const doc = await this.db.collection(STORIES_COLLECTION).doc(storyId).get();
    this.logger.log(`Retrieved story ${storyId}`);
    return doc.exists ? (doc.data() as Story) : null;
  }

  async getStoriesByUser(userId: string): Promise<Story[]> {
    const snapshot = await this.db
      .collection(STORIES_COLLECTION)
      .where('userId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    this.logger.log(`Retrieved stories for user ${userId}`);
    return snapshot.docs.map((d) => d.data() as Story);
  }

  async updateStatus(storyId: string, status: StoryStatus): Promise<void> {
    await this.db
      .collection(STORIES_COLLECTION)
      .doc(storyId)
      .update({ status, updatedAt: Date.now() });
    this.logger.log(`Updated status for story ${storyId}`);
  }

  // Upsert a page into the pages array
  async upsertPage(storyId: string, page: StoryPage): Promise<void> {
    const doc = await this.db.collection(STORIES_COLLECTION).doc(storyId).get();
    if (!doc.exists) return;

    const story = doc.data() as Story;
    const pages = story.pages ?? [];
    const idx = pages.findIndex((p) => p.pageNumber === page.pageNumber);

    if (idx >= 0) {
      pages[idx] = { ...pages[idx], ...page };
    } else {
      pages.push(page);
    }

    pages.sort((a, b) => a.pageNumber - b.pageNumber);
    await doc.ref.update({ pages, updatedAt: Date.now() });
    this.logger.log(`Upserted page ${page.pageNumber} for story ${storyId}`);
  }

  async updatePageImage(
    storyId: string,
    pageNumber: number,
    imageUrl: string,
  ): Promise<void> {
    const doc = await this.db.collection(STORIES_COLLECTION).doc(storyId).get();
    if (!doc.exists) return;

    const story = doc.data() as Story;
    const pages = story.pages.map((p) =>
      p.pageNumber === pageNumber ? { ...p, imageUrl } : p,
    );
    await doc.ref.update({ pages, updatedAt: Date.now() });
    this.logger.log(`Updated image for page ${pageNumber} of story ${storyId}`);
  }

  async updatePdfUrl(storyId: string, pdfUrl: string): Promise<void> {
    await this.db
      .collection(STORIES_COLLECTION)
      .doc(storyId)
      .update({ pdfUrl, updatedAt: Date.now() });
    this.logger.log(`Updated PDF URL for story ${storyId}`);
  }

  async deleteStory(storyId: string): Promise<void> {
    await this.db.collection(STORIES_COLLECTION).doc(storyId).delete();
    this.logger.log(`Deleted story ${storyId}`);
  }
}
