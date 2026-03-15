import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Storage, Bucket } from '@google-cloud/storage';

@Injectable()
export class GcsService implements OnModuleInit {
  private readonly logger = new Logger(GcsService.name);
  private storage!: Storage;
  private bucket!: Bucket;
  private readonly bucketName: string;
  private readonly signedUrlExpiryMinutes: number;

  constructor(private readonly config: ConfigService) {
    this.bucketName = this.config.getOrThrow<string>('GCS_BUCKET_NAME');
    this.signedUrlExpiryMinutes = parseInt(
      this.config.get('GCS_SIGNED_URL_EXPIRY_MINUTES', '60'),
    );
  }

  onModuleInit() {
    this.storage = new Storage({
      projectId: this.config.get('GCP_PROJECT_ID'),
    });
    this.bucket = this.storage.bucket(this.bucketName);
    this.logger.log(`GCS initialized — bucket: ${this.bucketName}`);
  }

  // ──────────────────────────────────────────────────────────
  //  Upload base64-encoded content to GCS
  //  Returns a time-limited signed URL for the frontend
  // ──────────────────────────────────────────────────────────
  async uploadBase64(
    base64Data: string,
    gcsPath: string,
    contentType: string,
  ): Promise<string> {
    const buffer = Buffer.from(base64Data, 'base64');
    const file = this.bucket.file(gcsPath);

    await file.save(buffer, {
      metadata: { contentType },
      resumable: false,
    });

    return this.getSignedUrl(gcsPath);
  }

  // ──────────────────────────────────────────────────────────
  //  Upload raw buffer
  // ──────────────────────────────────────────────────────────
  async uploadBuffer(
    buffer: Buffer,
    gcsPath: string,
    contentType: string,
  ): Promise<string> {
    const file = this.bucket.file(gcsPath);

    await file.save(buffer, {
      metadata: { contentType },
      resumable: false,
    });

    return this.getSignedUrl(gcsPath);
  }

  // ──────────────────────────────────────────────────────────
  //  Generate a time-limited signed URL
  // ──────────────────────────────────────────────────────────
  async getSignedUrl(gcsPath: string): Promise<string> {
    const expiresMs = Date.now() + this.signedUrlExpiryMinutes * 60 * 1000;

    const [url] = await this.bucket.file(gcsPath).getSignedUrl({
      action: 'read',
      expires: expiresMs,
    });

    return url;
  }

  // ──────────────────────────────────────────────────────────
  //  Delete a file from GCS
  // ──────────────────────────────────────────────────────────
  async deleteFile(gcsPath: string): Promise<void> {
    await this.bucket.file(gcsPath).delete({ ignoreNotFound: true });
  }
}
