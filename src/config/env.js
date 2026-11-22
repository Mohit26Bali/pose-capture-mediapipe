const path = require('path');
// override: true because Windows machines can carry pre-existing env vars
// (e.g. this host has a system "Mongo_DB" pointing at the MongoDB install dir)
// that collide case-insensitively with our own names. Our .env is authoritative.
// ENV_FILE lets tests (or a second deployment) use a different file, e.g. ENV_FILE=.env.test.
const envFile = path.resolve(__dirname, '../../', process.env.ENV_FILE || '.env');
require('dotenv').config({ path: envFile, override: true });

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** A whole number >= min from the environment, or the fallback when unset or not a valid number. */
function int(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

const nodeEnv = process.env.NODE_ENV || 'development';

const config = {
  env: nodeEnv,
  port: Number(process.env.PORT || 4000),

  /**
   * Shared secret for the API. When set, every request except /health and the static UI shell must send
   * it as "Authorization: Bearer <key>" or "x-api-key: <key>". When unset the API is open, which is only
   * acceptable on your own machine: in production the server refuses to start without it unless
   * ALLOW_OPEN_API=true is set on purpose.
   */
  security: {
    apiKey: process.env.API_KEY || '',
    allowOpenApi: bool('ALLOW_OPEN_API', false),
    // Number of reverse proxies in front of the app (Render counts as 1). Rate limits believe
    // X-Forwarded-For only when this is above 0.
    trustedProxyHops: int('TRUSTED_PROXY_HOPS', 0),
    uploadsPerMinute: int('UPLOADS_PER_MIN', 20, 1),
    readsPerMinute: int('READS_PER_MIN', 300, 1),
    backupsPerHour: int('BACKUPS_PER_HOUR', 4, 1),
  },

  postgres: {
    host: required('PG_HOST', 'localhost'),
    port: Number(process.env.PG_PORT || 5432),
    database: required('PG_DATABASE'),
    user: required('PG_USER'),
    password: required('PG_PASSWORD'),
    dumpPath: process.env.PG_DUMP_PATH || 'pg_dump',
  },

  mongo: {
    uri: required('MONGO_URI', 'mongodb://localhost:27017'),
    dbName: required('MONGO_DB'),
    imageCollection: process.env.MONGO_IMAGE_COLLECTION || 'images',
    mongodumpPath: process.env.MONGODUMP_PATH || 'mongodump',
  },

  python: {
    executable: process.env.PYTHON_EXECUTABLE || 'python',
    script: path.resolve(__dirname, '../../', process.env.POSE_EXTRACTOR_SCRIPT || './python/pose_extractor.py'),
    timeoutMs: Number(process.env.POSE_EXTRACTION_TIMEOUT_MS || 30000),
    modelPath: process.env.POSE_LANDMARKER_MODEL_PATH
      ? path.resolve(__dirname, '../../', process.env.POSE_LANDMARKER_MODEL_PATH)
      : path.resolve(__dirname, '../../python/models/pose_landmarker_full.task'),
    maxPeople: Number(process.env.POSE_MAX_PEOPLE || 5),
    minDetectionConfidence: Number(process.env.POSE_MIN_DETECTION_CONFIDENCE || 0.5),
    minPresenceConfidence: Number(process.env.POSE_MIN_PRESENCE_CONFIDENCE || 0.5),
    // Scan the image in overlapping crops as well, to find small or distant people.
    tiling: bool('POSE_TILING', true),
    // Long-lived Python processes that keep the model loaded (0 = start Python for every request, slow).
    workers: int('POSE_WORKERS', 2),
    // Requests allowed to wait for a free worker before the API answers 503 "busy".
    queueMax: int('POSE_QUEUE_MAX', 20),
  },

  upload: {
    maxSizeBytes: Number(process.env.MAX_UPLOAD_SIZE_MB || 10) * 1024 * 1024,
    // A small file can still decode to a huge bitmap (a 20000 x 20000 PNG is a few MB). Refuse those.
    maxPixels: int('MAX_IMAGE_MEGAPIXELS', 40, 1) * 1_000_000,
    tmpDir: path.resolve(__dirname, '../../', process.env.UPLOAD_TMP_DIR || './uploads_tmp'),
  },

  // Empty/unset = NO cross-origin access. The web UI is served by this same server, so it needs none.
  // Set a comma-separated list to allow other sites to call the API from a browser.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  backup: {
    dir: path.resolve(__dirname, '../../', process.env.BACKUP_DIR || './backups'),
    tmpDir: path.resolve(__dirname, '../../', process.env.BACKUP_TMP_DIR || './backups/tmp'),
    cronSchedule: process.env.BACKUP_CRON_SCHEDULE || '59 23 * * *',
    // IANA time zone for the schedule, e.g. "Asia/Kolkata". Unset = the server's own zone (UTC on most hosts).
    timezone: process.env.BACKUP_TIMEZONE || undefined,
    retentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 14),
  },

  email: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
    maxAttachmentBytes: Number(process.env.EMAIL_MAX_ATTACHMENT_MB || 20) * 1024 * 1024,
    // The backup contains every uploaded photo. Set false to email only a notification, not the file.
    attachBackup: bool('EMAIL_ATTACH_BACKUP', true),
  },
};

module.exports = config;
