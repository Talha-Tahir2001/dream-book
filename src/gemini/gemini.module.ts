import { Module } from '@nestjs/common';
import { GeminiService } from './gemini.service';
import { ImagenService } from './imagen.service';
import { TtsService } from './tts.service';
import { VoiceGateway } from './voice.gateway';
import { GcsModule } from '../gcs/gcs.module';

@Module({
  imports: [GcsModule],
  providers: [GeminiService, ImagenService, TtsService, VoiceGateway],
  exports: [GeminiService, ImagenService, TtsService],
})
export class GeminiModule {}
