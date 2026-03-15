import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private _app!: admin.app.App;
  // private readonly serviceAccount
  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    if (admin.apps.length > 0) {
      this._app = admin.apps[0]!;
      return;
    }

    // On Cloud Run, GOOGLE_APPLICATION_CREDENTIALS is handled automatically
    // via the service account attached to the Cloud Run service.
    // Locally, point GOOGLE_APPLICATION_CREDENTIALS to your service-account.json.
    this._app = admin.initializeApp({
      credential: admin.credential.cert(
        this.config.getOrThrow<string>('GOOGLE_APPLICATION_CREDENTIALS'),
      ),
      projectId: this.config.get<string>('FIREBASE_PROJECT_ID'),
    });

    this.logger.log('Firebase Admin SDK initialized');
  }

  get auth(): admin.auth.Auth {
    return this._app.auth();
  }

  get firestore(): admin.firestore.Firestore {
    return this._app.firestore();
  }
}
