import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CloudTasksClient } from '@google-cloud/tasks';
import { IllustrationJob } from '../shared/schemas';

@Injectable()
export class CloudTasksService {
  private readonly logger = new Logger(CloudTasksService.name);
  private readonly client: CloudTasksClient;
  private readonly queuePath: string;
  private readonly handlerUrl: string;

  constructor(private readonly config: ConfigService) {
    this.client = new CloudTasksClient();

    const project = this.config.getOrThrow<string>('GCP_PROJECT_ID');
    const location = this.config.get<string>(
      'CLOUD_TASKS_QUEUE_LOCATION',
      'us-central1',
    );
    const queue = this.config.getOrThrow<string>('CLOUD_TASKS_QUEUE');

    this.queuePath = this.client.queuePath(project, location, queue);
    this.handlerUrl = this.config.getOrThrow<string>('CLOUD_TASKS_HANDLER_URL');
  }

  // ──────────────────────────────────────────────────────────
  //  Dispatch an illustration job to Cloud Tasks.
  //  Cloud Tasks will POST the job payload to our
  //  InternalController, which calls Imagen and stores the result.
  //
  //  Benefits: all page illustrations run in parallel,
  //  not blocking the SSE stream.
  // ──────────────────────────────────────────────────────────
  async dispatchIllustrationJob(job: IllustrationJob): Promise<void> {
    const payload = Buffer.from(JSON.stringify(job)).toString('base64');

    const task = {
      httpRequest: {
        httpMethod: 'POST' as const,
        url: this.handlerUrl,
        headers: {
          'Content-Type': 'application/json',
          // Internal auth header — verify in InternalController
          'X-Internal-Secret': this.config.get<string>(
            'INTERNAL_SECRET',
            'dev-secret',
          ),
        },
        body: payload,
      },
    };

    const [response] = await this.client.createTask({
      parent: this.queuePath,
      task,
    });

    this.logger.log(
      `Dispatched illustration job for story ${job.storyId} page ${job.pageNumber}: ${response.name}`,
    );
  }
}
