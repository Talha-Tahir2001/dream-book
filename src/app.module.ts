import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { FirebaseModule } from './firebase/firebase.module';
import { GcsModule } from './gcs/gcs.module';
import { StoryModule } from './story/story.module';
import { PdfModule } from './pdf/pdf.module';
import { HealthModule } from './health/health.module';
import { InternalModule } from './internal/internal.module';
import { GeminiModule } from './gemini/gemini.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    FirebaseModule,
    GcsModule,
    StoryModule,
    GeminiModule,
    PdfModule,
    HealthModule,
    InternalModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
