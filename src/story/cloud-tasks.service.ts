import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IllustrationJob } from '../shared/schemas';
import { CloudTasksClient } from '@google-cloud/tasks';

@Injectable()
export class CloudTasksService {
  private readonly logger = new Logger(CloudTasksService.name);
  private readonly isConfigured: boolean;
  private readonly queuePath: string;
  private readonly handlerUrl: string;
  private readonly internalSecret: string;

  constructor(private readonly config: ConfigService) {
    const project = this.config.get<string>('GCP_PROJECT_ID', '');
    const location = this.config.get<string>(
      'CLOUD_TASKS_QUEUE_LOCATION',
      'us-central1',
    );
    const queue = this.config.get<string>('CLOUD_TASKS_QUEUE', '');
    const handlerUrl = this.config.get<string>('CLOUD_TASKS_HANDLER_URL', '');

    // Only fully initialise when all required values are present.
    // In local dev / Docker testing these are absent — that's fine because
    // StoryService uses direct Imagen calls when NODE_ENV !== 'production'.
    this.isConfigured = Boolean(project && queue && handlerUrl);
    this.internalSecret = this.config.get<string>(
      'INTERNAL_SECRET',
      'dev-secret',
    );

    if (this.isConfigured) {
      const client = new CloudTasksClient();
      this.queuePath = client.queuePath(project, location, queue);
      this.handlerUrl = handlerUrl;
      this.logger.log(`Cloud Tasks configured — queue: ${queue}`);
    } else {
      this.queuePath = '';
      this.handlerUrl = '';
      this.logger.warn(
        'Cloud Tasks not configured (CLOUD_TASKS_QUEUE / CLOUD_TASKS_HANDLER_URL missing). ' +
          'Illustrations will run directly — this is expected in local/dev mode.',
      );
    }
  }

  async dispatchIllustrationJob(job: IllustrationJob): Promise<void> {
    if (!this.isConfigured) {
      this.logger.warn(
        `Cloud Tasks not configured — skipping dispatch for story ${job.storyId} page ${job.pageNumber}`,
      );
      return;
    }

    const client = new CloudTasksClient();

    const payload = Buffer.from(JSON.stringify(job)).toString('base64');

    const [response] = await client.createTask({
      parent: this.queuePath,
      task: {
        httpRequest: {
          httpMethod: 'POST' as const,
          url: this.handlerUrl,
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': this.internalSecret,
          },
          body: payload,
        },
      },
    });

    this.logger.log(
      `Dispatched illustration job for story ${job.storyId} page ${job.pageNumber}: ${response.name}`,
    );
  }
}
