import { Module } from '@nestjs/common';
import { StoryController } from './story.controller';
import { StoryService } from './story.service';
import { FirestoreService } from './firestore.service';
import { CloudTasksService } from './cloud-tasks.service';
import { GeminiModule } from '../gemini/gemini.module';
import { GcsModule } from '../gcs/gcs.module';
import { PdfModule } from '../pdf/pdf.module';
import { FirebaseModule } from '../firebase/firebase.module';

@Module({
  imports: [FirebaseModule, GeminiModule, GcsModule, PdfModule],
  controllers: [StoryController],
  providers: [StoryService, FirestoreService, CloudTasksService],
  exports: [StoryService, FirestoreService],
})
export class StoryModule {}
