# Pose Capture Backend

A backend system that accepts an uploaded image, extracts 33 body pose keypoints
**per person** (multiple people per image supported) using **Python +
MediaPipe Pose**, stores the keypoints in **PostgreSQL**, stores the original
image in **MongoDB**, exposes a REST CRUD API, and runs a nightly **cron
backup** (PostgreSQL dump + MongoDB dump, zipped, and emailed).

A minimal **web UI** (`public/`, served by the same Express server) is included
so you can exercise the whole system — upload, view a skeleton overlay, browse
records, trigger a backup — without touching curl/Postman. See
[§12 Using the Web UI](#12-using-the-web-ui).

---

## 1. Project Overview

| Requirement | Implementation |
|---|---|
| Accept image via API | `POST /extract-pose` (multipart/form-data, field `image`) |
| Extract 33 keypoints per person, multiple people per image | `python/pose_extractor.py` (MediaPipe Tasks `PoseLandmarker`), invoked as a subprocess |
| Store keypoints | PostgreSQL table `pose_records` (JSONB column, one entry per detected person) |
| Store original image | MongoDB collection `images` (binary + metadata) |
| REST CRUD | `src/routes/poseRoutes.js` |
| Daily backup | `node-cron` at `23:59`, `src/services/backupScheduler.js` |
| Export both DBs | `pg_dump` (SQL) + `mongodump` (BSON) — real dump tools, not raw file copies |
| Zip | `archiver` → `/backups/yyyy-mm-dd-backup.zip` |
| Email notification | Nodemailer/SMTP, subject `Daily DB Backup - {{DATE}}` |

---

## 2. Architecture

```
                          ┌───────────────────────┐
   multipart/form-data    │        Express         │
  ───────────────────────▶│  routes → controllers  │
                          │  → services → repos     │
                          └───────────┬─────────────┘
                                      │
                 ┌────────────────────┼─────────────────────┐
                 ▼                    ▼                      ▼
        imageRepository      poseExtractionService     poseRecordRepository
        (MongoDB driver)     (spawns Python process)    (pg / PostgreSQL)
                 │                    │                      │
                 ▼                    ▼                      ▼
             MongoDB          python/pose_extractor.py    PostgreSQL
          (original image)      (MediaPipe Pose)         (pose_records)
```

**Layering** (`src/`):
- `routes/` — HTTP method + path wiring only.
- `controllers/` — request/response shaping, calls services, no business logic.
- `services/` — orchestration & business logic (pose extraction bridge, upload
  orchestration incl. rollback, backup pipeline, email).
- `repositories/` — the only code that talks to PostgreSQL/MongoDB directly.
- `middleware/` — multer upload config, UUID validation, centralized error handler.
- `db/` — connection pools/clients + the SQL schema/migration.
- `config/env.js` — the only place `process.env` is read; everything else imports
  this module.

### Why the Postgres record references the Mongo document

`pose_records.mongo_image_id` stores the Mongo `ObjectId` as a 24-char hex string
(`pose_records.mongo_db` / `mongo_collection` are also stored so the reference is
self-describing even if the Mongo database/collection name ever changes). Postgres
is the "owning" side of the relationship: all CRUD reads/writes go through
`pose_records` first, and `GET /records/:id/image` uses the stored
`mongo_image_id` to fetch the binary from Mongo on demand. This keeps the
relational data (which is queried/filtered/joined) in Postgres, and the large
binary blobs (which are only ever fetched by a direct ID lookup) in Mongo — a
standard "hybrid persistence" split.

Mongo documents do **not** store a back-reference to Postgres; they're pure
image blobs (`{ data: Buffer, contentType, originalFilename, sizeBytes,
uploadedAt }`).

### Why this structure instead of the PDF's suggested layout

The brief's suggested tree (`routes/controllers/services/models/db/middleware/utils`)
is used as-is, with one addition: a `repositories/` layer separating "talks to
Postgres/Mongo" (repositories) from "orchestrates a multi-step operation, applies
rollback logic" (services). For `POST /extract-pose`, which writes to two
databases and a subprocess, this separation is what makes the rollback logic
(delete the Mongo image if pose extraction or the Postgres insert fails)
readable in one place (`services/poseRecordService.js`) instead of scattered
across a controller. No other structural deviation from the assignment.

---

## 3. Prerequisites

| Tool | Version used in this build | Notes |
|---|---|---|
| Node.js | 22.17.1 | Any Node 18+ should work |
| PostgreSQL | 17.4 | `pg_dump` must be reachable (see `PG_DUMP_PATH`) |
| MongoDB | local `mongod` service | |
| MongoDB Database Tools | 100.17.0 | Provides `mongodump` (NOT bundled with the MongoDB server or `mongosh`) |
| Python | 3.12 (dedicated environment) | **MediaPipe does not support Python 3.13+.** See below. |
| PoseLandmarker model file | `pose_landmarker_full.task` (~9.4MB) | Downloaded separately, not via pip. See below. |

### ⚠️ Important: Python version

MediaPipe's Python wheels only go up to Python 3.12. If your machine's default
Python is newer (this dev machine had 3.14 installed), you must create a
separate Python 3.12 environment for this project and point `PYTHON_EXECUTABLE`
at it. On Windows, the easiest path is Conda:

```powershell
conda create -y -n posecapture python=3.12
conda activate posecapture
pip install -r python/requirements.txt
```

`python/requirements.txt` pins `mediapipe==0.10.21`, which ships **both** the
legacy `mediapipe.solutions` API and the newer Tasks API in the same package —
no separate install needed either way. `pose_extractor.py` uses the Tasks API
(`vision.PoseLandmarker`) specifically because, unlike the legacy API, it
supports detecting **multiple people in one image** (`num_poses`), which the
legacy single-person API cannot do.

Without Conda, any Python 3.9–3.12 virtualenv works identically:

```bash
python3.12 -m venv python/venv
source python/venv/bin/activate      # python/venv/Scripts/activate on Windows
pip install -r python/requirements.txt
```

### Download the PoseLandmarker model file

The Tasks API loads its model from a `.task` file that is **not** distributed
via pip — download it once into `python/models/` (gitignored, ~9.4MB):

```powershell
Invoke-WebRequest `
  -Uri "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/latest/pose_landmarker_full.task" `
  -OutFile "python\models\pose_landmarker_full.task"
```

(This is Google's official MediaPipe model asset host — the same URL
referenced in MediaPipe's own documentation. `pose_landmarker_lite.task` is a
faster/less-accurate alternative; `pose_landmarker_heavy.task` is
slower/more-accurate. Swap the filename in the URL and in
`POSE_LANDMARKER_MODEL_PATH` to change tiers.)

### MongoDB Database Tools

`mongodump` ships separately from the MongoDB server/`mongosh`. Install via:

```powershell
winget install --id MongoDB.DatabaseTools -e
```

or download from the official MongoDB Database Tools page. Confirm the
`.exe` path and set `MONGODUMP_PATH` in `.env` accordingly (or add it to
`PATH` and leave the variable empty).

---

## 4. PostgreSQL Setup

```powershell
# Create the database (adjust user as needed)
psql -U postgres -h localhost -c "CREATE DATABASE pose_capture;"
```

Apply the schema:

```bash
npm run migrate
```

This runs `src/db/migrate.js`, which executes `src/db/schema.sql` — creates the
`pose_records` table, indexes, the `pgcrypto` extension (for `gen_random_uuid()`),
and an `updated_at` trigger. It is idempotent (`CREATE TABLE IF NOT EXISTS`,
`CREATE OR REPLACE`) and safe to re-run.

## 5. MongoDB Setup

No manual setup needed beyond a running `mongod` — the `images` collection is
created automatically on first insert. Ensure the MongoDB service is running:

```powershell
# Windows service (installed via the MongoDB MSI installer)
net start MongoDB
```

## 6. Python / MediaPipe Setup

See [Prerequisites](#3-prerequisites) above. Verify the extractor works
standalone before wiring up the server:

```powershell
C:\path\to\posecapture\python.exe python\pose_extractor.py tests\sample_pose.jpg
```

Expected: a single line of JSON on stdout with `"success": true`.

## 7. Node.js Setup

```bash
npm install
```

## 8. Environment Variables

Copy `.env.example` to `.env` and fill in real values:

```bash
cp .env.example .env
```

| Variable | Purpose |
|---|---|
| `PORT` | Express server port |
| `PG_HOST`/`PG_PORT`/`PG_DATABASE`/`PG_USER`/`PG_PASSWORD` | PostgreSQL connection |
| `PG_DUMP_PATH` | Absolute path to `pg_dump` (leave empty to use `PATH`) |
| `MONGO_URI`/`MONGO_DB`/`MONGO_IMAGE_COLLECTION` | MongoDB connection |
| `MONGODUMP_PATH` | Absolute path to `mongodump` (leave empty to use `PATH`) |
| `PYTHON_EXECUTABLE` | Absolute path to a Python 3.9–3.12 interpreter with `mediapipe` installed |
| `POSE_EXTRACTOR_SCRIPT` | Path to `pose_extractor.py` (defaults correctly, rarely needs changing) |
| `POSE_EXTRACTION_TIMEOUT_MS` | Kill the Python subprocess after this long |
| `POSE_LANDMARKER_MODEL_PATH` | Path to the downloaded `.task` model file |
| `POSE_MAX_PEOPLE` | Max number of people to detect per image (default 5) |
| `POSE_MIN_DETECTION_CONFIDENCE` / `POSE_MIN_PRESENCE_CONFIDENCE` | Confidence thresholds (0-1) for accepting a detected pose |
| `MAX_UPLOAD_SIZE_MB` / `UPLOAD_TMP_DIR` | Multer upload limits/staging dir |
| `API_KEY` | Shared secret for the API (16+ characters). When set, every data route needs `Authorization: Bearer <key>` or `x-api-key`. **Required in production**: the server refuses to start without it unless `ALLOW_OPEN_API=true` |
| `ALLOW_OPEN_API` | Set `true` only if something else already protects the service (private network, authenticating proxy) |
| `TRUSTED_PROXY_HOPS` | Reverse proxies in front of the app (Render = 1). Rate limits believe `X-Forwarded-For` only when this is above 0 |
| `UPLOADS_PER_MIN` / `READS_PER_MIN` / `BACKUPS_PER_HOUR` | Per-visitor rate limits (defaults 20 / 300 / 4) |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist. Empty = **no** cross-origin access (the bundled UI is same-origin and needs none) |
| `POSE_WORKERS` | Long-lived Python processes that keep the model loaded (default 2; `0` = start Python for every image, about 4 s slower) |
| `POSE_QUEUE_MAX` | Requests allowed to wait for a free worker before the API answers 503 (default 20) |
| `POSE_TILING` | `true` (default): also scan the image in 6 overlapping crops to find small or distant people |
| `MAX_IMAGE_MEGAPIXELS` | Refuse images that decode to more pixels than this (default 40) |
| `BACKUP_TIMEZONE` | IANA zone for the backup schedule, e.g. `Asia/Kolkata` (default: the server's zone, UTC on most hosts) |
| `EMAIL_ATTACH_BACKUP` | `false` = email a notification only, never the file (the backup contains every uploaded photo) |
| `BACKUP_DIR` / `BACKUP_TMP_DIR` / `BACKUP_CRON_SCHEDULE` | Backup output location and schedule (cron syntax, default `59 23 * * *` = 11:59 PM daily) |
| `BACKUP_RETENTION_DAYS` | Backup ZIPs older than this are deleted after each successful run (0 = keep forever) |
| `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASSWORD`/`EMAIL_FROM`/`EMAIL_TO` | Nodemailer SMTP transport |
| `EMAIL_MAX_ATTACHMENT_MB` | Above this, the ZIP is not attached — the email instead points to its path on the server |

**Never commit `.env`.** It is gitignored.

### Gmail SMTP note

If using Gmail: you cannot use your normal password. Enable 2FA on the
account, then generate an **App Password** (Google Account → Security → App
passwords) and use that as `SMTP_PASSWORD`. Using a real account password will
fail with `Invalid login: 535-5.7.8 ... BadCredentials` (this is exactly the
error you'll see if `.env` still has placeholder values, as this repo's does
by default).

---

## 9. Installation

```bash
npm install
npm run migrate
```

## 10. Running the Server

```bash
npm start          # node src/server.js
npm run dev         # same, with --watch for auto-restart
```

On startup the server:
1. Verifies the PostgreSQL connection.
2. Connects to MongoDB.
3. Schedules the daily backup cron job.
4. Starts listening on `PORT` (default `4000`).

Check readiness:

```bash
curl http://localhost:4000/health
# {"server":"ok","postgres":"ok","mongo":"ok"}
```

---

## 11. API Documentation

All error responses follow: `{ "error": "<Name>", "message": "<human readable>" }`
(sometimes with a `details` object).

### `POST /extract-pose`

Accepts an image, stores it in MongoDB, runs MediaPipe pose extraction
(**multi-person aware** — detects up to `POSE_MAX_PEOPLE` people in one
image), and stores the resulting per-person keypoints in PostgreSQL.

- **Body:** `multipart/form-data`, field name `image` (jpeg/png/webp/bmp, ≤10MB by default)
- **Success:** `201 Created`
- **Failure modes:**
  | Status | Cause |
  |---|---|
  | 400 | No file provided |
  | 415 | Unsupported MIME type |
  | 413 | File exceeds `MAX_UPLOAD_SIZE_MB` |
  | 422 | File is not a decodable image (corrupt/invalid) — image is NOT persisted |
  | 502 | MongoDB write failed, PostgreSQL write failed, or the Python process crashed/timed out — any partial write (e.g. the Mongo image) is rolled back |

**curl (single person detected):**
```bash
curl -X POST http://localhost:4000/extract-pose \
  -F "image=@tests/sample_pose.jpg;type=image/jpeg"
```

**Response (201):**
```json
{
  "message": "Pose extracted successfully",
  "duplicate": false,
  "record": {
    "id": "ca0658d8-48a0-4af1-8ba9-98ce8e67ce06",
    "poseDetected": true,
    "personCount": 1,
    "landmarkCount": 33,
    "poses": [
      {
        "personIndex": 0,
        "keypoints": [
          { "index": 0, "name": "NOSE", "x": 0.464189, "y": 0.277454, "z": -1.228351, "visibility": 0.999914 },
          { "index": 1, "name": "LEFT_EYE_INNER", "x": 0.486365, "y": 0.243485, "z": -1.21374, "visibility": 0.99985 }
          /* ... 33 total ... */
        ]
      }
    ],
    "originalFilename": "sample_pose.jpg",
    "contentType": "image/jpeg",
    "fileSizeBytes": 10762,
    "imageWidth": 233,
    "imageHeight": 350,
    "createdAt": "2026-08-09T06:54:25.247Z",
    "image": {
      "mongoImageId": "6a78241ce0813dc08bf27b7d",
      "mongoDb": "pose_capture",
      "mongoCollection": "images",
      "url": "/records/ca0658d8-48a0-4af1-8ba9-98ce8e67ce06/image"
    }
  }
}
```

**curl (multi-person photo — `poses` has one entry per person):**
```bash
curl -X POST http://localhost:4000/extract-pose \
  -F "image=@tests/sample_multi_pose.jpg;type=image/jpeg"
# message: "Pose extracted successfully for 2 people", record.personCount: 2,
# record.landmarkCount: 66, record.poses.length: 2
```

**curl (no pose in image — still 201, `poseDetected: false`):**
```bash
curl -X POST http://localhost:4000/extract-pose \
  -F "image=@tests/sample_no_pose.jpg;type=image/jpeg"
# record.personCount: 0, record.poses: null
```

**curl (re-uploading the exact same file — duplicate detection):**
```bash
curl -X POST http://localhost:4000/extract-pose \
  -F "image=@tests/sample_pose.jpg;type=image/jpeg"
# "duplicate": true — returns the EXISTING record (same id as the first
# upload) instead of creating a second Mongo image + Postgres row. Detected
# via a SHA-256 hash of the file bytes (pose_records.content_hash, unique
# index). No Mongo write and no MediaPipe invocation happen for a duplicate,
# so the response is near-instant.
```

**curl (corrupt file — 422):**
```bash
curl -X POST http://localhost:4000/extract-pose \
  -F "image=@tests/sample_invalid.jpg;type=image/jpeg"
# {"error":"ApiError","message":"Pose extraction failed: File could not be decoded as an image (unsupported or corrupt file)","details":{"errorType":"invalid_image"}}
```

### `GET /records`

List records, newest first.

- **Query params:**
  - `limit` (default 20, max 100), `offset` (default 0)
  - `search` — case-insensitive substring match on `originalFilename`
  - `poseDetected` — `"true"` or `"false"` to filter by whether a pose was found

```bash
curl "http://localhost:4000/records?limit=5&offset=0"
curl "http://localhost:4000/records?search=yoga&poseDetected=true"
```
```json
{ "total": 3, "limit": 5, "offset": 0, "records": [ { "id": "...", "poseDetected": true, "personCount": 1, "...": "..." } ] }
```

### `GET /records/:id`

```bash
curl http://localhost:4000/records/ca0658d8-48a0-4af1-8ba9-98ce8e67ce06
```
- `400` if `:id` is not a valid UUID. `404` if it doesn't exist.

### `GET /records/:id/image`

Streams the **original** image bytes back from MongoDB with the correct `Content-Type`.

```bash
curl http://localhost:4000/records/ca0658d8-48a0-4af1-8ba9-98ce8e67ce06/image -o downloaded.jpg
```

Add `?thumbnail=true` to instead get a small on-the-fly JPEG (96×96, resized
with `sharp`, never persisted) — used by the records table in the web UI so
listing many records doesn't transfer full-size images just to render 48px
thumbnails. The original stored in MongoDB is never modified or replaced.

```bash
curl "http://localhost:4000/records/ca0658d8-48a0-4af1-8ba9-98ce8e67ce06/image?thumbnail=true" -o thumb.jpg
```

### `PUT /records/:id` / `PATCH /records/:id`

Updates allowed fields: `originalFilename`, `poseDetected`, `personCount`, `landmarkCount`, `poses`.
(Both verbs behave identically here — partial update — since the assignment
lists `PUT/PATCH` together and there is no full-replace semantic that would
differ from a partial update for this resource.)

```bash
curl -X PATCH http://localhost:4000/records/ca0658d8-48a0-4af1-8ba9-98ce8e67ce06 \
  -H "Content-Type: application/json" \
  -d '{"originalFilename": "renamed.jpg"}'
```
- `400` if no updatable field is present in the body. `404` if the record doesn't exist.

### `DELETE /records/:id`

Deletes the PostgreSQL record **and** its corresponding MongoDB image.

```bash
curl -X DELETE http://localhost:4000/records/ca0658d8-48a0-4af1-8ba9-98ce8e67ce06
```

### `GET /health`

```bash
curl http://localhost:4000/health
```

### `POST /backup/run`

Triggers the same backup pipeline the nightly cron job runs (pg_dump +
mongodump + zip + email), synchronously, and returns the result. Mainly
exists so the web UI (§12) can offer a "Run Backup Now" button without
requiring a terminal.

```bash
curl -X POST http://localhost:4000/backup/run
```

---

## 12. Using the Web UI

A small static single-page app is served directly by the Express server at
[`http://localhost:4000`](http://localhost:4000) — no separate build step or
dev server, no npm frontend dependencies. It's plain HTML/CSS/vanilla JS
(`public/index.html`, `public/app.js`, `public/styles.css`) calling the same
REST API documented in §11, so it's never out of sync with what curl/Postman
can do.

Start the backend as usual (`npm start`) and open the URL in a browser. Three
panels, top to bottom:

1. **Extract Pose** — client-side validated (type + size, before any network
   request) drag-and-drop or click to choose an image, preview it, then
   **Extract Pose** (a spinner shows while MediaPipe runs — extraction takes a
   few seconds). The result renders the uploaded photo on a `<canvas>` with
   every detected person's skeleton drawn on top, **one distinct color per
   person** for multi-person photos, plus the pose-detected flag, person
   count, total landmark count, and the full raw JSON in a collapsible
   `<details>`. Landmarks below 50% visibility (e.g. a leg occluded by
   another body part) are not drawn, rather than rendering a misleadingly
   confident skeleton over a joint MediaPipe couldn't actually see.
2. **Records** — a paginated, searchable table of every record (filename
   substring search + pose-detected filter, both server-side so they work
   across the full dataset, not just the current page). Thumbnails are
   96×96 on-the-fly resizes (`?thumbnail=true`), not the full original, to
   keep the table light. **View** opens a modal with the same skeleton
   overlay, an editable filename (`PATCH`), and a delete button. **Delete**
   on the table row itself removes the record (and its Mongo image) directly.
3. **Backup** — a **Run Backup Now** button that calls `POST /backup/run` and
   prints the full result JSON (zip path, size, retention cleanup, and email
   send status) once it completes — useful for confirming the backup
   pipeline works without waiting for 11:59 PM or opening a terminal.

A green/red dot pair in the top-right header reflects live PostgreSQL/MongoDB
connectivity (same data as `GET /health`, polled every 15s).

This was verified end-to-end with a scripted browser (Playwright): health
dots go green, the records table populates with real thumbnails, uploading a
multi-person photo produces two distinctly-colored, correctly-aligned
skeletons with `personCount: 2`, the spinner appears during real extraction
and is skipped (correctly) for a duplicate upload, search/filter narrow the
table correctly, client-side validation rejects a bad file before any network
call, the detail modal opens with the same overlay, and the backup button
surfaces the real pipeline result — with zero browser console errors
throughout.

### Sample test images

`tests/sample_pose.jpg` / `sample_no_pose.jpg` / `sample_invalid.jpg` (used by
the automated tests) are minimal fixtures. For a wider variety of real photos
to click through in the UI, `python/fetch_sample_pose_images.py` downloads a
small set from Pexels (people in different poses, plus a couple of
person-less scenes) into `tests/fixtures/pexels/` — it reuses whatever Pexels
API key is already configured in a sibling script rather than embedding a new
key in this repo:

```bash
C:\ProgramData\Anaconda3\envs\posecapture\python.exe python/fetch_sample_pose_images.py
```

(Edit `HOTEL_SCRIPT_PATH` at the top of the script if your existing
Pexels-key-bearing script lives somewhere other than
`D:\images\fetch_hotel_images_pexels.py`, or just hardcode your own key if you
don't have one.) `tests/fixtures/` is gitignored — these are third-party stock
photos, not project assets.

---

## 13. Node ↔ Python Contract

`src/services/poseExtractionService.js` spawns:

```
<PYTHON_EXECUTABLE> <POSE_EXTRACTOR_SCRIPT> <path-to-temp-image-file>
```

with `POSE_LANDMARKER_MODEL_PATH` / `POSE_MAX_PEOPLE` /
`POSE_MIN_DETECTION_CONFIDENCE` / `POSE_MIN_PRESENCE_CONFIDENCE` passed
through as environment variables to the subprocess.

- Exactly one line of JSON is printed to **stdout**. All MediaPipe/TensorFlow
  logging goes to **stderr** and is ignored for parsing but captured for error
  messages.
- Exit code `0` + `"success": true` → either one or more people were found
  (`pose_detected: true`, `person_count: N`, `poses: [{person_index,
  keypoints: [...33]}, ...]`) or genuinely none were (`pose_detected: false,
  person_count: 0, poses: null`) — **both are treated as a successful API
  call**, since "no person in the photo" is a valid real-world result, not an
  error.
- Exit code `1` + `"success": false` → a real processing failure (corrupt
  file, missing file, missing model file, MediaPipe crash). Node maps this to
  HTTP 422 (bad input) or 502 (processing/environment failure) depending on
  `error_type`.
- If Node can't parse stdout as JSON at all, or the subprocess fails to spawn,
  or it exceeds `POSE_EXTRACTION_TIMEOUT_MS` (subprocess is killed), that's
  also surfaced as a `PoseExtractionError` → HTTP 502.
- Node re-keys the Python response from snake_case to camelCase
  (`person_index` → `personIndex`, etc.) before it touches the database or API
  response — Python's output format and the JSON API's format are
  deliberately decoupled at that one boundary.

Full JSON shapes are documented in the docstring at the top of
`python/pose_extractor.py`.

---

## 14. Cron / Backup Behavior

- Scheduled via `node-cron` in `src/services/backupScheduler.js` using
  `BACKUP_CRON_SCHEDULE` (default `59 23 * * *` → 11:59 PM daily, server's
  local timezone).
- Pipeline (`src/services/backupService.js`), for `yyyy-mm-dd` = today:
  1. `pg_dump` → `backups/tmp/yyyy-mm-dd/postgres_dump.sql` (plain SQL, schema + data — a real logical dump, not a copy of Postgres's data files)
  2. `mongodump` → `backups/tmp/yyyy-mm-dd/mongo_dump/<db>/*.bson` (a real logical export, not a copy of MongoDB's data files)
  3. `archiver` zips that temp directory → `backups/yyyy-mm-dd-backup.zip`
  4. The zip is verified to exist and be non-empty (throws otherwise)
  5. The temp directory is deleted (`finally` block — runs even if a later step fails)
  6. An email is sent (ZIP attached if ≤ `EMAIL_MAX_ATTACHMENT_MB`, otherwise a
     note with the server-side path). Email failure is caught and reported in
     the result rather than crashing the backup job — **a failed email does
     not mean a failed backup**, since the ZIP was already safely written to
     disk.
  7. Backup ZIPs older than `BACKUP_RETENTION_DAYS` (default 14, based on the
     date in the filename) are deleted. Set to `0` to keep every backup
     forever. A deletion failure here is logged and swallowed, never thrown —
     it must not turn a successful backup into a failure.
- Only one backup runs at a time (an in-process flag plus a lock file in `BACKUP_DIR`, so `npm run backup`
  cannot collide with the server's own run); a second request gets `409`. The ZIP is written under a
  temporary name and renamed when complete, so a crash never replaces a good backup with a partial file.
- The MongoDB URI (which usually holds a password) is given to `mongodump` through a private config
  file that is deleted straight after, not as a command-line argument, and error text is stripped of
  credentials before it is logged, returned or emailed.
- A database with no images yet is a valid (empty) backup, not a failure.
- If the dump/zip steps themselves fail (steps 1-4), a **failure alert email**
  is attempted (`Daily DB Backup FAILED - {{DATE}}`, via
  `sendBackupFailureEmail`) before the error is re-thrown — so a broken
  nightly cron run doesn't fail completely silently. This attempt is
  best-effort: if email also isn't configured/working, the failure is still
  visible in the server logs / the caller's rejected promise.
- Run it manually any time (does not require waiting for 11:59 PM):
  ```bash
  npm run backup
  ```

---

## 15. Email Configuration

Uses Nodemailer with a generic SMTP transport (`src/services/emailService.js`)
— works with Gmail, Outlook, Mailtrap, SendGrid's SMTP relay, etc. Configure
via the `SMTP_*` / `EMAIL_*` variables in `.env` (see [section 8](#8-environment-variables)).
If SMTP is not configured (missing host/user/password), the backup still
completes successfully; the email step is skipped and reported as
`{ sent: false, reason: "Email not configured..." }` rather than failing the
whole backup.

Subject line: `Daily DB Backup - {{DATE}}` (e.g. `Daily DB Backup - 2026-08-09`), per the spec.

---

## 16. Database Dump / Restore Instructions

A sample dump produced by this exact system is committed at
[`sample_dump/`](./sample_dump) (`postgres_dump.sql` + `mongo_dump/pose_capture/`),
generated from `backups/2026-08-09-backup.zip`.

**Restore PostgreSQL:**
```bash
psql -U postgres -h localhost -d pose_capture -f sample_dump/postgres_dump.sql
```

**Restore MongoDB:**
```bash
mongorestore --uri="mongodb://localhost:27017" --db=pose_capture sample_dump/mongo_dump/pose_capture
```

---

## 17. Testing

Automated tests use Node's built-in test runner (`node:test`) against a real
local Postgres + Mongo (no mocks) — this exercises the actual `pg_dump` /
`mongodump` binaries and the actual Python subprocess, not stand-ins.

```bash
npm test
```

Tests run against separate databases so they never touch your data: create `.env.test` (a copy of `.env`
with `PG_DATABASE=pose_capture_test`, `MONGO_DB=pose_capture_test`, no SMTP settings, and its own backup and upload
directories), create the empty `pose_capture_test` database, then run `ENV_FILE=.env.test npm test`.
50 tests in total (the 23 below plus 27 in `tests/hardening.test.js`: API key, upload checks, validation, rate
limits, the worker pool, backup locking, and a real restore into scratch databases). Original 23:
- `tests/api.test.js` — health check; `/extract-pose` success (single person),
  success (multi-person, asserts `personCount > 1`), duplicate-upload
  detection (re-upload returns the same record id, no second row created),
  success (no pose found), 422 on corrupt file, 400 on missing file, 415 on
  wrong mime type; full CRUD cycle including 400/404 edge cases; verifies
  `DELETE` removes both the Postgres row and the Mongo image.
- `tests/poseExtraction.test.js` — the Node↔Python bridge directly: 33
  keypoints for a single-person photo, `personCount > 1` with unique
  `personIndex` values for a multi-person photo, `pose_detected:false` for a
  person-less photo, proper rejection for corrupt/missing files.
- `tests/backup.test.js` — runs the real backup pipeline, unzips the result,
  and asserts the SQL dump contains `COPY public.pose_records` (i.e. actual
  row data) and the Mongo dump directory exists; asserts the temp directory
  was cleaned up.

`tests/sample_pose.jpg`, `tests/sample_multi_pose.jpg`, `tests/sample_no_pose.jpg`,
and `tests/sample_invalid.jpg` are fixture images (a single-person portrait, a
4-person group photo, a person-less landscape, and a deliberately corrupt
file) used by every pose-related test above. Backup retention
(`applyRetentionPolicy`) and the CORS origin allowlist were verified manually
(see the "Backup / Cron" and "Environment Variables" sections above for what
was checked) rather than via `node:test`, since they depend on
filesystem-date and cross-origin-request setup that's simpler to validate
directly.

### Manually testing failure cases

```bash
# PostgreSQL down: stop the service, then hit any endpoint that touches Postgres
net stop postgresql-x64-17
curl http://localhost:4000/health   # -> postgres: "error: ..."

# MongoDB down:
net stop MongoDB
curl http://localhost:4000/health   # -> mongo: "error: ..."

# Python misconfigured: point PYTHON_EXECUTABLE at a non-existent path in .env, restart, then:
curl -X POST http://localhost:4000/extract-pose -F "image=@tests/sample_pose.jpg;type=image/jpeg"
# -> 502, "Failed to start Python process: ..."
```

---

## 18. Deployment (Render)

> **Not tested end-to-end.** This section was written against Render's
> documented Docker-based Web Service workflow, but no Docker was available
> in the environment this project was built in to actually run `docker build`
> or deploy it. Treat the `Dockerfile` and the steps below as a solid
> starting point, not a verified-working deployment — build and smoke-test
> locally with `docker build . && docker run` before pushing to Render if you
> can.

This app isn't a simple "push and go" deploy: it shells out to `pg_dump`,
`mongodump`, and a Python/MediaPipe subprocess, none of which exist in a
default Node buildpack. `Dockerfile` (project root) bundles all of that -
Node 22, Python 3.12 + MediaPipe, `postgresql-client`, and MongoDB Database
Tools - into one image, based on `ubuntu:24.04`.

### What you need beyond Render itself

Render doesn't offer a managed MongoDB, and this setup assumes **no**
persistent disk (per your choice — see the caveat below), so:

- **PostgreSQL:** use Render's own managed Postgres add-on, or any other
  reachable Postgres instance.
- **MongoDB:** use MongoDB Atlas (free tier is enough) or any other reachable
  MongoDB instance — Render has nothing native for this.
- **SMTP:** same as local — Mailtrap for testing, or real SMTP creds for real
  delivery.

### Steps

1. Push this repo to GitHub (or GitLab/Bitbucket — whatever Render's Git
   integration supports).
2. In the Render dashboard: **New → Web Service**, connect the repo.
3. **Root Directory:** `backend` (if the repo root is `Image capture/` with
   this project inside a `backend/` subfolder, as it is here).
4. **Runtime:** Docker (Render auto-detects the `Dockerfile`).
5. **Environment variables** — set every variable from `.env.example`
   (§8) in Render's dashboard, pointing at your managed Postgres/Mongo/SMTP,
   e.g.:
   ```
   PG_HOST=<your Render Postgres host>
   PG_PORT=5432
   PG_DATABASE=pose_capture
   PG_USER=...
   PG_PASSWORD=...
   MONGO_URI=mongodb+srv://.../pose_capture
   MONGO_DB=pose_capture
   ALLOWED_ORIGINS=https://<your-render-app>.onrender.com
   SMTP_HOST=... SMTP_USER=... SMTP_PASSWORD=... EMAIL_TO=...
   ```
   Leave `PYTHON_EXECUTABLE`, `PG_DUMP_PATH`, `MONGODUMP_PATH`,
   `POSE_LANDMARKER_MODEL_PATH` unset — the `Dockerfile` already sets those
   to match what it installed.
6. **Pre-Deploy Command** (Render has a field for this, run before each
   deploy goes live): `npm run migrate` — applies `db/schema.sql`, idempotent,
   safe to run on every deploy.
7. Deploy. Render builds the Docker image (this will be slow the first time —
   installing Python, Node, MediaPipe, and downloading the ~9.4MB model file
   all happen during the build) and starts `node src/server.js` per the
   `Dockerfile`'s `CMD`.
8. Verify: `curl https://<your-app>.onrender.com/health`.

### Two things that genuinely don't work the same as local, because you chose no persistent disk

- **Backups don't survive a restart or redeploy.** `/backups` lives on the
  container's ephemeral filesystem — Render can restart/redeploy the
  container at any time, wiping it. The **email attachment is the only
  durable copy** in this setup; nothing lands anywhere durable if email isn't
  configured. If you later want backups to actually persist, that requires
  either a Render persistent disk (paid add-on) or uploading the ZIP
  somewhere external (S3, etc.) after creating it — **not implemented**, since
  it wasn't part of what you asked for.
- **The nightly cron job needs an always-on process.** `node-cron` fires
  inside the running Node process — if Render spins the service down during
  inactivity (free tier does this), the 11:59 PM trigger simply won't fire
  that night, because nothing is running to fire it. Either use a paid
  always-on Render instance plan, or replace the in-process cron with
  Render's own **Cron Job** resource type (a separate scheduled resource that
  runs `node src/utils/runBackupNow.js` on Render's own clock, independent of
  whether the web service is awake) — the latter is the more robust choice on
  a platform with sleeping services, but isn't the architecture currently
  wired up (`backupScheduler.js` assumes an always-running process).

---

## 19. Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `module 'mediapipe' has no attribute 'solutions'` | You have mediapipe 1.0.0+ installed. `pip install mediapipe==0.10.21` (see [section 3](#3-prerequisites)). |
| `ModuleNotFoundError: No module named 'cv2'`/`mediapipe` | `PYTHON_EXECUTABLE` doesn't point at the environment where `pip install -r python/requirements.txt` was run. |
| `PoseLandmarker model file not found at ...` (422/502 on every upload) | You haven't downloaded the `.task` model file yet, or `POSE_LANDMARKER_MODEL_PATH` points somewhere else. See "Download the PoseLandmarker model file" in [section 3](#3-prerequisites). |
| Multi-person photo misses people | See [§24](#24-review-findings-and-measured-behaviour). `POSE_TILING=true` (default) finds most small or distant people; heavily overlapping people are still the weak spot. Records created before tiling existed keep their old result until you run `npm run reprocess`. |
| Pose extraction always returns 502 "invalid output" | Something (e.g. a `print()` you added for debugging) is writing extra text to **stdout** in `pose_extractor.py`. All diagnostics must go to stderr — stdout must be pure JSON. |
| `Missing required environment variable: PG_DATABASE` (or similar) on startup | `.env` is missing or incomplete; copy from `.env.example`. |
| Env var seems to silently use the wrong value even though `.env` looks right | On Windows, some installers (e.g. MongoDB's) set machine-wide env vars (case-insensitively) that can collide with this project's names. `src/config/env.js` loads `.env` with `override: true` specifically to win against this — but if you add a *new* env var, name it distinctively to avoid surprises. |
| `pg_dump: command not found` / backup fails immediately | Set `PG_DUMP_PATH` in `.env` to the full path of `pg_dump`(`.exe`), or add its folder to `PATH`. |
| `mongodump: command not found` | Install "MongoDB Database Tools" separately from the MongoDB server — `mongosh` alone does not include it. Set `MONGODUMP_PATH` if not on `PATH`. |
| Backup email fails with `BadCredentials` | Placeholder SMTP creds in `.env`, or (for Gmail) using your normal password instead of an App Password. See [section 8](#8-environment-variables). |
| `EBUSY`/file lock errors during `npm install` on Windows | Usually antivirus/indexer transiently locking a file in `node_modules`; re-run `npm install`. |

---

## 20. Known Limitations

- Authentication is a single shared API key, not per-user accounts. Anyone who has the key can see, change and delete every photo. Real per-user access control (and consent/retention rules for photos of people) is out of scope; see [§24](#24-review-findings-and-measured-behaviour).
- `node-cron`'s bundled `uuid` dependency has an open moderate advisory
  (buffer-bounds check, only reachable if a caller supplies a raw `buf` to
  `uuid.v3/v5/v6`, which `node-cron` never does) — `npm audit` will flag it;
  upgrading requires node-cron v4, a breaking API change, and was judged not
  worth the churn for an unreachable code path.
- Email delivery has not been verified against a real inbox in this
  environment (SMTP credentials in `.env` are placeholders) — the pipeline
  itself is fully tested (`tests/backup.test.js` + manual run) up to the
  Nodemailer `sendMail` call, whose failure is caught and reported rather than
  crashing the backup. This also applies to the newer backup-failure alert
  email (`sendBackupFailureEmail`).
- Multi-person detection quality depends on the chosen model tier
  (`pose_landmarker_full.task` by default) and confidence thresholds; small,
  heavily occluded, or fast-moving people in a crowd can still be missed —
  see the Troubleshooting entry above. `POSE_MAX_PEOPLE` caps detection at 5
  people by default for latency reasons; raise it via `.env` if needed.
- No pagination cursor beyond `limit`/`offset` (fine at this scale; would need
  revisiting for very large record counts). Filename search (`?search=`) uses
  a simple `ILIKE`, not a full-text index — fine at this scale too.
- The uploaded image is held in memory as a single `Buffer` for the Mongo
  write and passed to the Python subprocess via a temp file path — fine for
  the `MAX_UPLOAD_SIZE_MB=10` default; very large images/videos would need
  streaming instead. The original bytes stored in MongoDB are never resized;
  only the UI's `?thumbnail=true` response is (generated on the fly, never
  persisted).
- Duplicate detection is exact-bytes-only (SHA-256 of the raw file) — a
  re-saved/re-compressed copy of the same photo will hash differently and be
  treated as a new upload. Perceptual/near-duplicate detection is out of
  scope.

---

## 21. Screenshots / Postman Evidence

No screenshot images are included in this repo (this system was built and
verified via automated tests + curl in a headless environment, not a GUI).
Every request/response pair under [section 11](#11-api-documentation) above
was captured from **actual runs against the live local server** during
development — treat those as the evidence in place of screenshots. To
generate your own Postman screenshots, import the curl commands above into
Postman (`Import → Raw text`) and run them against `http://localhost:4000`
with the server started as in [section 10](#10-running-the-server).

---

## 22. Final Project Structure

```
backend/
├── src/
│   ├── app.js                       # Express app: middleware, routes, error handlers
│   ├── server.js                    # Entrypoint: connects DBs, schedules cron, listens
│   ├── config/env.js                # Single source of truth for process.env
│   ├── db/
│   │   ├── postgres.js              # pg Pool + query/transaction helpers
│   │   ├── mongo.js                 # MongoClient singleton
│   │   ├── schema.sql               # pose_records DDL
│   │   └── migrate.js               # Applies schema.sql
│   ├── routes/poseRoutes.js
│   ├── controllers/
│   │   ├── poseController.js
│   │   └── backupController.js      # POST /backup/run (manual trigger, used by the web UI)
│   ├── services/
│   │   ├── poseExtractionService.js # Node <-> Python bridge
│   │   ├── poseRecordService.js     # Upload orchestration + rollback
│   │   ├── backupService.js         # pg_dump + mongodump + archiver pipeline
│   │   ├── backupScheduler.js       # node-cron wiring
│   │   └── emailService.js          # Nodemailer
│   ├── repositories/
│   │   ├── poseRecordRepository.js  # Postgres CRUD
│   │   └── imageRepository.js       # Mongo CRUD
│   ├── middleware/
│   │   ├── upload.js                # multer config + MIME allowlist
│   │   ├── validateUuid.js
│   │   └── errorHandler.js
│   └── utils/
│       ├── asyncHandler.js
│       └── runBackupNow.js          # `npm run backup`
├── public/                          # Static web UI (served by Express, see §12)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── python/
│   ├── pose_extractor.py
│   ├── requirements.txt
│   ├── fetch_sample_pose_images.py  # optional: pull extra sample photos from Pexels
│   └── models/                      # gitignored: pose_landmarker_full.task goes here (see §3)
├── tests/
│   ├── api.test.js
│   ├── poseExtraction.test.js
│   ├── backup.test.js
│   ├── sample_pose.jpg              # fixtures: 1 person
│   ├── sample_multi_pose.jpg        # fixtures: 4 people (2 reliably detected)
│   ├── sample_no_pose.jpg           # fixtures: no person
│   ├── sample_invalid.jpg           # fixtures: corrupt file
│   └── fixtures/pexels/             # optional extra fixtures (gitignored, see §12)
├── sample_dump/                     # committed sample SQL + Mongo export
├── backups/                         # generated ZIPs (gitignored)
├── Dockerfile                       # deployment image (see §18) - untested, no Docker available locally
├── .dockerignore
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

---

## 23. Requirement Checklist

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | Accept image via API | ✅ | `POST /extract-pose`, `middleware/upload.js` |
| 2 | Extract 33 keypoints via Python + MediaPipe | ✅ | `python/pose_extractor.py` |
| 3 | Store keypoints in PostgreSQL | ✅ | `repositories/poseRecordRepository.js`, `db/schema.sql` |
| 4 | Store original image in MongoDB | ✅ | `repositories/imageRepository.js` |
| 5 | REST CRUD | ✅ | `routes/poseRoutes.js`, `controllers/poseController.js` |
| 6 | `/extract-pose` endpoint | ✅ | as above |
| 7 | Daily backup at 11:59 PM | ✅ | `services/backupScheduler.js` (`BACKUP_CRON_SCHEDULE=59 23 * * *`) |
| 8 | Export full Postgres + Mongo data | ✅ | `services/backupService.js` via `pg_dump`/`mongodump` (real dump tools, not raw file copy) |
| 9 | ZIP at `/backup/yyyy-mm-dd-backup.zip` | ✅ | `backups/yyyy-mm-dd-backup.zip` (`BACKUP_DIR`, defaults to `./backups`) |
| 10 | Email ZIP/link after backup | ✅ | `services/emailService.js`, attaches or links based on size |
| 11 | README + API examples | ✅ | this file |
| 12 | Node/Express main backend | ✅ | `src/app.js`, `src/server.js` |
| 13 | Python as separate component | ✅ | `python/pose_extractor.py`, invoked via `child_process.spawn` |
| 14 | Clean layering (routes/controllers/services/db/middleware/utils) | ✅ | `src/` structure (see §22) |
| 15 | Env vars for all config/secrets | ✅ | `config/env.js`, `.env.example`, nothing hardcoded |
| 16 | Sensible Postgres schema (id, keypoints, timestamps, Mongo ref) | ✅ | `db/schema.sql` |
| 17 | Explain Postgres↔Mongo reference | ✅ | §2 above |
| 18 | Python script: accept image, extract, return JSON, handle no-pose | ✅ | `python/pose_extractor.py` |
| 19 | Defined JSON format for Python output | ✅ | docstring in `pose_extractor.py`, §13 |
| 20 | Robust, error-aware Node↔Python communication | ✅ | `services/poseExtractionService.js` (timeout, JSON-parse guard, spawn-error guard) |
| 21 | RESTful endpoints w/ correct status codes | ✅ | §11 |
| 22 | `/extract-pose`: validate, store image, run extraction, store keypoints, useful response | ✅ | `services/poseRecordService.js` |
| 23 | Handle invalid/missing/unsupported image | ✅ | `middleware/upload.js` (415/413), `poseController.js` (400) |
| 24 | Handle image processing failure / no pose | ✅ | `poseExtractionService.js`, `pose_extractor.py` (no-pose ≠ error) |
| 25 | Handle Postgres/Mongo/Python/backup/email failures | ✅ | `poseRecordService.js`, `backupService.js`, `emailService.js`, `errorHandler.js` |
| 26 | No partial records — rollback/cleanup | ✅ | `poseRecordService.js` deletes the Mongo image if extraction or the Postgres insert fails; temp upload file always removed |
| 27 | Backup: export → temp dir → zip → verify → email → cleanup | ✅ | `backupService.js` (`runBackup`) |
| 28 | Use real DB dump mechanisms, not raw file copy | ✅ | `pg_dump` (SQL) + `mongodump` (BSON) |
| 29 | `.env.example` with all vars | ✅ | `.env.example` |
| 30 | Don't commit secrets/generated files | ✅ | `.gitignore` |
| 31 | Clean project structure | ✅ | §22 |
| 32 | Tests: API, pose success/no-pose, CRUD, Postgres/Mongo persistence, backup+ZIP, email, failures | ✅ | `tests/*.test.js`, §17 |
| 33 | curl/Postman examples for every endpoint | ✅ | §11 |
| 34 *(bonus, not in spec)* | Web UI so no commands are needed to test the system | ✅ | `public/`, §12 |
| 35 *(bonus, not in spec)* | Multi-person pose detection (not just one person per image) | ✅ | `python/pose_extractor.py` (Tasks API `PoseLandmarker`), `pose_records.person_count` |
| 36 *(bonus, not in spec)* | Duplicate-upload detection (same file bytes → reuse existing record) | ✅ | `pose_records.content_hash` (SHA-256, unique index), `poseRecordService.js` |
| 37 *(bonus, not in spec)* | Backup retention/rotation (old ZIPs auto-deleted) | ✅ | `backupService.js` (`applyRetentionPolicy`, `BACKUP_RETENTION_DAYS`) |
| 38 *(bonus, not in spec)* | Backup-failure alert email (distinct from the success notification) | ✅ | `emailService.js` (`sendBackupFailureEmail`) |
| 39 *(bonus, not in spec)* | CORS restricted to a configured origin allowlist (optional) | ✅ | `app.js`, `ALLOWED_ORIGINS` |
| 40 *(bonus, not in spec)* | On-the-fly image thumbnails (bandwidth-efficient records table) | ✅ | `poseController.js` (`?thumbnail=true`, `sharp`), original in Mongo untouched |
| 41 *(bonus, not in spec)* | Server-side filename search + pose-detected filter | ✅ | `poseRecordRepository.findAll` (`search`, `poseDetected` params) |
| 42 *(bonus, not in spec)* | Deployment instructions (Docker image + Render steps) | ⚠️ written, **not build/deploy-tested** (no Docker available locally) | `Dockerfile`, §18 |

---

## 24. Review findings and measured behaviour

This section records what was measured on the real system (25 test photographs, a local PostgreSQL 17 and MongoDB 8) and what was changed as a result.

### How accurate is the pose extraction?

Measured on 72 Pexels photographs (the 25 in `tests/fixtures/pexels`, then 47 more fetched through the Pexels API for the cases the first set did not cover). Every photo was viewed and its people counted by eye; 63 of them have a clear count of 0 to 5 people and are scored below. The other 9 are crowds of 8 or more.

| | One pass over the image | With tiling (`POSE_TILING=true`, default) |
|---|---|---|
| People found, of 86 people in 63 photos | about 60% | about 87% |
| Photos with no person that still got a false detection (13 photos) | 2 | 6 |

**What works:** one person, any pose (standing, walking, running, sitting, lying down, advanced yoga), including partial body: in upper-body portraits the hidden legs get coordinates but a visibility near 0 (0.0 to 0.5), so filter on per-joint `visibility`. Two to four separated people are found most of the time.

**What does not:**
- *Small or distant people:* one pass misses them (four friends in a wide shot: 1 found). Tiling fixes most of this, which is where its gain comes from.
- *False alarms from tiling:* looking at enlarged crops makes the model see people in human-shaped things. Dogs, toy figurines and shop mannequins were reported as people in 6 of 13 person-free photos (statues were not). A single pass had 2. If you care more about "never report a person who is not there" than about finding every small person, set `POSE_TILING=false`. Tuning the crop-acceptance threshold from 0.75 to 0.95 changed almost nothing.
- *Crowds and dense groups:* 8 or more people are mostly missed (a football huddle: 1 of about 10; a row of yoga students: 2 of 8; a dense street crowd: 0). `POSE_MAX_PEOPLE` also caps the answer (default 5).
- *Overlap:* people standing very close (a family of four, a couple embracing) often merge into one tangled skeleton.
- *Darkness, motion blur and silhouettes:* three of four such photos gave nothing.
- The person-level mean `visibility` is **not** a reliability signal: wrong skeletons scored 0.8 to 0.9.

The tiling rules were tuned on the first 25 photos, then checked on the other 47, where the gain held up (about 54% to 78% on the new set alone). Counts were made by one person looking at the images, so a small error either way is possible. Use these as the shape of the behaviour, not as exact accuracy.

### Speed

The original design started Python and loaded the model for every image: about 4.2 seconds each (median over the 25 photos), and unlimited concurrent uploads each started their own process. A pool of long-lived workers (`POSE_WORKERS`, default 2) loads the model once; an image then takes about 0.7 seconds including tiling. Requests queue (`POSE_QUEUE_MAX`) and the API answers 503 when the queue is full instead of running the machine out of memory.

### What was wrong and is now fixed

| Area | Problem | Fix |
|---|---|---|
| Access | No authentication: anyone could upload, list, view, change or delete photos of people, and trigger backups | `API_KEY`; refuses to start in production without it; rate limits; CORS closed by default |
| Uploads | File type came from what the browser claimed; a few KB of PNG could describe a gigantic bitmap and exhaust memory | Type read from the file's bytes; pixel limit (`MAX_IMAGE_MEGAPIXELS`); filenames cleaned |
| Record updates | `PATCH` accepted any JSON for the keypoints and any counts | Strict validation; counts are derived from the keypoints |
| List queries | A negative `offset` or `limit` caused a database error (500); `%` and `_` in a search acted as wildcards | Validated (400); wildcards escaped |
| Errors | Database, file-system and tool error text (hosts, ports, paths) was returned to clients and by `/health` | Generic messages; details only in the server log |
| Duplicate uploads | Two identical uploads at the same moment: one failed with an error | The second is answered with the first's record, and no orphan image is left |
| Backup | A fresh install with no images failed its first nightly backup; two backups at once (cron plus a button click) corrupted each other; the Mongo password was on the command line and could appear in the failure email | Empty database accepted; one backup at a time (lock file); password via a private config file and redacted |
| Workers | A killed worker's late exit event orphaned its replacement process | Fixed, with a test |
| Docker | `.dockerignore` had a garbled line; the image ran as root | Fixed (the image has still not been built here) |

### Backups: what they do and do not protect against

The nightly job produces a correct dump (a test restores it into scratch databases and compares the rows and the image bytes). But:

- The ZIP is written to the **same machine** that holds the databases and, without a persistent disk, is lost when the container is replaced. The only copy that leaves the server is the email attachment.
- The ZIP contains **every uploaded photo**, unencrypted, and is emailed. Set `EMAIL_ATTACH_BACKUP=false` if that is not acceptable, and copy backups to storage you control.
- The two dumps are taken one after the other (PostgreSQL first), not as one snapshot; an upload in between leaves an image with no row in the backup, which is harmless.

### Privacy

The system stores photographs of people and their body keypoints. Depending on where it is used (including India's DPDP Act and the EU's GDPR), that is personal data and may need a lawful basis or consent, a retention rule and a way to delete someone's data. This codebase provides deletion (`DELETE /records/:id`, which removes the row and the image) but no consent capture, no retention policy and no audit log.

### Reprocessing

Results are computed once, at upload. After changing the extraction (a new model, tiling, thresholds) run `npm run reprocess -- --dry-run` to see which records would change, then `npm run reprocess`.

### Possible improvements

- A person detector first (for example an object detector), then pose estimation on each person's crop: the proper fix for crowded scenes.
- Per-user accounts and roles; consent and retention handling for the photos.
- Copy backups to object storage, encrypt them, and run the schedule from a platform cron job instead of inside the web process.
- A background job for uploads (answer immediately, process afterwards) if traffic grows.
- A cleanup job that finds images with no row and rows with no image after a failed delete.
