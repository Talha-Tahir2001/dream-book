import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { GcsModule } from '../gcs/gcs.module';

@Module({
  imports: [GcsModule],
  providers: [PdfService],
  exports: [PdfService],
})
export class PdfModule {}
