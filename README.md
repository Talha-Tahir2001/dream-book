<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://coveralls.io/github/nestjs/nest?branch=master" target="_blank"><img src="https://coveralls.io/repos/github/nestjs/nest/badge.svg?branch=master#9" alt="Coverage" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->


# DreamBook API 📖

> **NestJS backend for DreamBook** — an AI-powered personalized children's storybook generator.
> Built for the **Gemini Live Agent Hackathon 2026** (Creative Storyteller category).
>
> 🏆 **Live Demo:** https://dream-book-web.vercel.app
> 🚀 **API Base URL:** https://dream-book-api-780143515127.us-central1.run.app 

---

## What is DreamBook?

A parent describes their child — name, age, interests, fears, a lesson to teach — either by typing or speaking naturally via voice. DreamBook generates a fully illustrated, narrated, personalized storybook in real time. Text streams in page by page, illustrations appear as they're generated, and audio narration is ready to play for each page. The completed story exports as a beautiful PDF storybook.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | NestJS 10 + TypeScript |
| Story Generation | Gemini 3.1 Pro Preview (interleaved streaming) |
| Image Generation | Nano Banana (`gemini-3.1-flash-image-preview`) |
| Text-to-Speech | `gemini-2.5-flash-preview-tts` via `generateContent` |
| Voice Input | Gemini Live API (`gemini-2.5-flash-native-audio-preview`) |
| AI SDK | `@google/genai` (official TypeScript SDK) |
| Auth | Firebase Admin SDK (JWT verification) |
| Database | Firestore (NoSQL) |
| File Storage | Google Cloud Storage (GCS) with signed URLs |
| Hosting | Google Cloud Run (containerized, auto-scaling) |
| CI/CD | Cloud Build (GitHub → Cloud Run on push to main) |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT (Next.js)                        │
│  Voice Input → Socket.io WS    Story Stream ← SSE (fetch)      │
└────────────────┬────────────────────────────────┬──────────────┘
                 │ WebSocket /voice                │ GET /stream
                 ▼                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                    NESTJS API  (Cloud Run)                      │
│                                                                 │
│  VoiceGateway          StoryController      FirebaseAuthGuard  │
│  └─ Gemini Live API    └─ SSE streaming     └─ JWT validation  │
│     (transcription)       (Observable)                         │
│                                                                 │
│  StoryService (pipeline orchestrator)                          │
│  ├─ GeminiService    → streams text + [IMAGE:] directives      │
│  ├─ ImagenService    → Nano Banana illustrations               │
│  ├─ TtsService       → audio narration per page               │
│  ├─ PdfService       → assembled storybook PDF                │
│  └─ FirestoreService → story persistence                      │
└────────┬──────────────────────┬───────────────────────────────┘
         │                      │
         ▼                      ▼
┌────────────────┐   ┌──────────────────────────────────────────┐
│   Firestore    │   │          Google Cloud Services           │
│  (stories DB)  │   │  ┌─────────────┐  ┌───────────────────┐ │
└────────────────┘   │  │ Cloud Storage│  │    Vertex AI /    │ │
                     │  │ (images,     │  │  Gemini API       │ │
                     │  │  audio, PDF) │  │  (all AI calls)   │ │
                     │  └─────────────┘  └───────────────────┘ │
                     └──────────────────────────────────────────┘
```




## High Level Design
![DreamBook Architecture](./docs/dreambook_architecture.svg)



---

## API Reference

### Authentication

All endpoints except `/api/health` require a Firebase ID token:

```
Authorization: Bearer <firebase-id-token>
```

---

### Endpoints

#### `GET /api/health`
Health check — no auth required.

**Response:**
```json
{ "status": "ok", "timestamp": "2026-03-16T11:21:11.522Z" }
```

---

#### `POST /api/stories`
Create a story record. Returns `storyId` immediately — then open the SSE stream.

**Request body:**
```json
{
  "childName": "Emma",
  "childAge": 5,
  "interests": ["dinosaurs", "painting"],
  "lesson": "Being brave means doing it even when you're scared",
  "fears": ["the dark"],
  "pageCount": 8,
  "illustrationStyle": "watercolor",
  "language": "en"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `childName` | string | ✅ | Child's first name |
| `childAge` | number (1–12) | ✅ | Child's age |
| `interests` | string[] (1–5) | ✅ | What the child loves |
| `lesson` | string | ❌ | Moral or lesson for the story |
| `fears` | string[] | ❌ | Fears to gently address |
| `pageCount` | number (4–12) | ✅ | Story length |
| `illustrationStyle` | `watercolor` \| `cartoon` \| `pencil-sketch` \| `digital-art` | ✅ | Art style |
| `language` | string | ✅ | ISO language code (e.g. `en`, `es`, `fr`) |

**Response `201`:**
```json
{ "storyId": "uuid-here" }
```

---

#### `GET /api/stories/:id/stream`
SSE stream — connects and receives events as the story generates.

**Response:** `text/event-stream`

Events emitted in order:

```
event: page:text
data: {"storyId":"...","pageNumber":1,"text":"Once upon a time..."}

event: page:image
data: {"storyId":"...","pageNumber":1,"imageUrl":"https://storage.googleapis.com/..."}

event: page:audio
data: {"storyId":"...","pageNumber":1,"audioUrl":"https://storage.googleapis.com/..."}

event: story:complete
data: {"storyId":"...","pageCount":8,"pdfUrl":"https://storage.googleapis.com/..."}

event: story:error
data: {"storyId":"...","message":"..."}
```

---

#### `GET /api/stories`
List all stories for the authenticated user.

**Response:**
```json
{
  "stories": [
    {
      "id": "uuid",
      "userId": "firebase-uid",
      "status": "complete",
      "pages": [...],
      "pdfUrl": "https://...",
      "createdAt": 1773661486000,
      "request": { "childName": "Emma", ... }
    }
  ]
}
```

---

#### `GET /api/stories/:id`
Fetch a single story with all page data.

---

#### `DELETE /api/stories/:id`
Delete a story. Returns `204 No Content`.

---

### WebSocket — Voice Input

**Namespace:** `/voice`
**Transport:** Socket.io over WebSocket

**Connection:**
```javascript
const socket = io('wss://https://dream-book-api-780143515127.us-central1.run.app.run.app/voice', {
  auth: { token: firebaseIdToken },
  transports: ['websocket']
});
```

**Client → Server events:**

| Event | Payload | Description |
|---|---|---|
| `voice:start` | — | Opens a Gemini Live session |
| `voice:audio` | `{ audioChunk: string }` | Base64 PCM 16kHz audio chunk |
| `voice:stop` | — | Closes session, extracts `StoryRequest` |

**Server → Client events:**

| Event | Payload | Description |
|---|---|---|
| `voice:transcript` | `{ text, isFinal }` | Live transcription as user speaks |
| `voice:result` | `{ storyRequest }` | Extracted `StoryRequest` JSON |
| `voice:error` | `{ message }` | Error description |

---

## Story Generation Pipeline

```
POST /api/stories          → creates Firestore record, returns storyId
GET  /api/stories/:id/stream → opens SSE connection

Pipeline (runs server-side):
  1. GeminiService.streamStory()
     └─ streams text + [IMAGE: prompt] directives
     └─ emits page:text events → forwarded to SSE immediately

  2. Per page (concurrent):
     ├─ TtsService.generateAndUpload()
     │   └─ gemini-2.5-flash-preview-tts → PCM → WAV → GCS
     │   └─ emits page:audio event when ready
     │
     └─ ImagenService.generateAndUpload()
         └─ gemini-3.1-flash-image-preview (Nano Banana) → PNG → GCS
         └─ emits page:image event when ready

  3. After all pages done:
     └─ PdfService.generate()
         └─ pdf-lib assembles landscape PDF (illustration left, text right)
         └─ uploads to GCS
         └─ emits story:complete with pdfUrl
```

---

## Local Development

### Prerequisites

- Node.js 20+
- `gcloud` CLI authenticated (`gcloud auth application-default login`)
- Firebase project created
- GCP project with APIs enabled

### Setup

```bash
# 1. Clone
git clone https://github.com/Talha-Tahir2001/dream-book
cd dream-book-api

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Fill in all values (see Environment Variables section below)

# 4. Start dev server
npm run start:dev
# API available at http://localhost:8000
```

### Enable GCP APIs

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  aiplatform.googleapis.com \
  storage.googleapis.com \
  firestore.googleapis.com \
  cloudtasks.googleapis.com \
  iamcredentials.googleapis.com
```

### Create GCS Bucket

```bash
gsutil mb -p YOUR_PROJECT_ID -l us-central1 gs://your-bucket-name
```

---

## Environment Variables

### Local `.env`

```bash
# ── Google Cloud ─────────────────────────────────────────────
GCP_PROJECT_ID=your-project-id
GCP_REGION=us-central1

# ── Gemini ───────────────────────────────────────────────────
GEMINI_API_KEY=AIzaSy...
GEMINI_MODEL=gemini-3.1-pro-preview

# ── Firebase ─────────────────────────────────────────────────
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
FIREBASE_PROJECT_ID=your-project-id

# ── Cloud Storage ────────────────────────────────────────────
GCS_BUCKET_NAME=your-bucket-name
GCS_SIGNED_URL_EXPIRY_MINUTES=60

# ── Illustration Mode ────────────────────────────────────────
# "direct" = call Nano Banana directly (local dev + Cloud Run)
# "tasks"  = use Cloud Tasks queue (only if configured)
ILLUSTRATION_MODE=direct

# ── App ──────────────────────────────────────────────────────
PORT=8000
NODE_ENV=development
CORS_ORIGINS=http://localhost:3000

# ── Internal Security ────────────────────────────────────────
INTERNAL_SECRET=your-random-secret
```

### Where to get each value

| Variable | Source |
|---|---|
| `GCP_PROJECT_ID` | GCP Console → project selector, or `gcloud projects list` |
| `GEMINI_API_KEY` | https://aistudio.google.com → Get API Key or Google Vertex AI |
| `FIREBASE_PROJECT_ID` | Firebase Console → Project Settings |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to downloaded service account JSON |
| `GCS_BUCKET_NAME` | Name chosen when running `gsutil mb` |
| `INTERNAL_SECRET` | Any random string you generate |

---

## Cloud Run Deployment

### IAM Permissions (required)

```bash
SA="YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com"
PROJECT="your-project-id"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/datastore.user"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/storage.objectAdmin"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/aiplatform.user"

gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"

# Required for GCS signed URLs
gcloud projects add-iam-policy-binding $PROJECT \
  --member="serviceAccount:$SA" --role="roles/iam.serviceAccountTokenCreator"
```

### Cloud Run Environment Variables

Set these in **Cloud Run → Edit & Deploy New Revision → Variables**:

```
NODE_ENV                = production
GCP_PROJECT_ID          = your-project-id
GCP_REGION              = us-central1
GEMINI_API_KEY          = AIzaSy...
GEMINI_MODEL            = gemini-3.1-pro-preview
FIREBASE_PROJECT_ID     = your-project-id
GCS_BUCKET_NAME         = your-bucket-name
INTERNAL_SECRET         = your-random-secret
ILLUSTRATION_MODE       = direct
CORS_ORIGINS            = https://your-nextjs-app.vercel.app
GCS_SIGNED_URL_EXPIRY_MINUTES = 60
```

### Cloud Run Settings

| Setting | Value | Reason |
|---|---|---|
| Memory | 2 GiB | Concurrent TTS + Imagen + PDF generation |
| CPU | 2 | Parallel processing per story |
| Request timeout | 3600s | SSE stream stays open during full generation |
| Min instances | 0 | Scale to zero when idle (cost saving) |
| Max instances | 10 | Enough for demo traffic |
| Execution environment | 2nd gen | Better network performance for streaming |
| Session affinity | Enabled | Required for WebSocket voice sessions |
| Authentication | Allow unauthenticated | Frontend calls API from browser |

### Enable session affinity (WebSocket support)

```bash
gcloud run services update your-api \
  --region=us-central1 \
  --session-affinity \
  --timeout=3600
```

### CI/CD — Continuous Deployment

This repo uses **Cloud Build** triggered by GitHub pushes to `main`. No manual deployment needed after initial setup.

Every `git push origin main` automatically:
1. Cloud Build pulls the repo
2. Builds the Docker image from `Dockerfile`
3. Pushes image to Artifact Registry
4. Deploys new revision to Cloud Run

---

## Project Structure

```
src/
├── main.ts                        ← App entry point
├── app.module.ts                  ← Root module
│
├── shared/
│   └── schemas.ts                 ← Zod schemas + TypeScript types
│                                    (copy to Next.js frontend too)
│
├── firebase/
│   ├── firebase.module.ts
│   ├── firebase.service.ts        ← Admin SDK initialization
│   └── firebase-auth.guard.ts     ← JWT verification on all routes
│
├── gemini/
│   ├── gemini.module.ts
│   ├── gemini.service.ts          ← Story text streaming (Gemini 3.1 Pro)
│   ├── imagen.service.ts          ← Illustrations (Nano Banana)
│   ├── tts.service.ts             ← Audio narration (TTS model)
│   └── voice.gateway.ts           ← WebSocket + Gemini Live API
│
├── gcs/
│   ├── gcs.module.ts
│   └── gcs.service.ts             ← Upload assets + generate signed URLs
│
├── story/
│   ├── story.module.ts
│   ├── story.controller.ts        ← REST endpoints + SSE stream
│   ├── story.service.ts           ← Pipeline orchestrator
│   ├── firestore.service.ts       ← All Firestore operations
│   └── cloud-tasks.service.ts     ← Cloud Tasks dispatcher (production)
│
├── pdf/
│   ├── pdf.module.ts
│   └── pdf.service.ts             ← Assemble landscape PDF storybook
│
├── internal/
│   ├── internal.module.ts
│   └── internal.controller.ts     ← Cloud Tasks webhook handler
│
└── health/
    ├── health.module.ts
    └── health.controller.ts       ← GET /api/health
```

---



## Testing with Postman

### 1. Get a Firebase token

```bash
npx ts-node get-test-token.ts
```

### 2. Health check (no auth)
```
GET https://dream-book-api-780143515127.us-central1.run.app/api/health
```

### 3. List stories
```
GET https://dream-book-api-780143515127.us-central1.run.app/api/stories
Authorization: Bearer <token>
```

### 4. Create a story
```
POST https://dream-book-api-780143515127.us-central1.run.app/api/stories
Authorization: Bearer <token>
Content-Type: application/json

{
  "childName": "Emma",
  "childAge": 5,
  "interests": ["dinosaurs"],
  "pageCount": 4,
  "illustrationStyle": "watercolor",
  "language": "en"
}
```

### 5. Stream a story (use curl)
```bash
curl -N \
  -H "Authorization: Bearer YOUR_TOKEN" \
  https://dream-book-api-780143515127.us-central1.run.app/api/stories/YOUR_STORY_ID/stream
```

---

## Hackathon Submission Notes

**Category:** Creative Storyteller ✍️ — Multimodal Storytelling with Interleaved Output

**Mandatory tech used:**
- ✅ Gemini's interleaved/mixed output — `gemini-3.1-pro-preview` streams text and image prompts in one output
- ✅ Google Cloud hosted — deployed on Cloud Run
- ✅ `@google/genai` SDK — used throughout (Gemini, Nano Banana, TTS, Live API)
- ✅ Gemini Live API — voice input uses `gemini-2.5-flash-native-audio-preview` for real-time transcription

**GCP Services used:**
- Cloud Run — backend hosting
- Cloud Build — CI/CD from GitHub
- Firestore — story persistence
- Cloud Storage — images, audio, PDFs
- Secret Manager — credential management
- Artifact Registry — Docker image storage

---

## License
This project is licensed under the MIT License. See the [LICENSE](https://github.com/Talha-Tahir2001/dream-book?tab=MIT-1-ov-file) file for details.
