import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private _app!: admin.app.App;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    if (admin.apps.length > 0) {
      this._app = admin.apps[0]!;
      return;
    }

    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');

    // On Cloud Run, use applicationDefault() — the Compute Engine
    // service account is automatically available via the metadata server.
    // No GOOGLE_APPLICATION_CREDENTIALS file needed in production.
    //
    // verifyIdToken() only needs the projectId to validate the JWT's
    // audience claim — it fetches Google's public keys from a public URL.
    try {
      this._app = admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId,
      });
      this.logger.log(
        `Firebase Admin initialized (applicationDefault) projectId=${projectId}`,
      );
    } catch (err) {
      // Fallback for environments where ADC is not available —
      // initialize without explicit credentials (works for token verification
      // since it only needs the public Google keys)
      this.logger.warn(
        `applicationDefault() failed: ${(err as Error).message}. ` +
          `Falling back to no-credential init — token verification will still work.`,
      );
      this._app = admin.initializeApp({ projectId });
    }
  }

  get auth(): admin.auth.Auth {
    return this._app.auth();
  }

  get firestore(): admin.firestore.Firestore {
    return this._app.firestore();
  }
}
