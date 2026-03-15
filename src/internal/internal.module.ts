import { Module } from '@nestjs/common';
import { StoryModule } from '../story/story.module';
import { GeminiModule } from '../gemini/gemini.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [StoryModule, GeminiModule],
  controllers: [InternalController],
})
export class InternalModule {}
