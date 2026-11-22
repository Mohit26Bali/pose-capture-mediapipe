const fs = require('fs');
const path = require('path');
const config = require('./config/env');
const app = require('./app');
const { connectMongo, closeMongo } = require('./db/mongo');
const { checkConnection: checkPostgres, pool } = require('./db/postgres');
const { scheduleBackupJob } = require('./services/backupScheduler');
const { warmUpPose, shutdownPose } = require('./services/poseExtractionService');

fs.mkdirSync(config.upload.tmpDir, { recursive: true });
fs.mkdirSync(config.backup.dir, { recursive: true });

/**
 * A server that exposes people's photos must not start wide open by accident. In production an API key
 * is mandatory unless ALLOW_OPEN_API=true says the operator meant it (for example, the service sits
 * behind a private network or an authenticating proxy).
 */
function assertSafeToStart() {
  if (config.security.apiKey) {
    if (config.security.apiKey.length < 16) {
      throw new Error('API_KEY is too short. Use at least 16 characters (for example: openssl rand -hex 24).');
    }
    return;
  }
  if (config.env === 'production' && !config.security.allowOpenApi) {
    throw new Error('API_KEY is not set. In production every upload, record and backup route would be public. ' +
      'Set API_KEY, or set ALLOW_OPEN_API=true if something else already protects this service.');
  }
  console.warn('[security] API_KEY is not set: the API is open to anyone who can reach this port. Fine on your own machine, not on a network.');
}

/** Uploads that were interrupted by a crash leave files behind; remove the old ones. */
function sweepTempUploads(maxAgeMs = 60 * 60 * 1000) {
  try {
    for (const name of fs.readdirSync(config.upload.tmpDir)) {
      if (name === '.gitkeep') continue;
      const full = path.join(config.upload.tmpDir, name);
      const stat = fs.statSync(full);
      if (stat.isFile() && Date.now() - stat.mtimeMs > maxAgeMs) fs.unlinkSync(full);
    }
  } catch (err) {
    console.warn('[startup] could not sweep temp uploads:', err.message);
  }
}

let server;
let schedulerTask;

async function start() {
  assertSafeToStart();
  sweepTempUploads();

  await checkPostgres();
  console.log('[startup] PostgreSQL connected');

  await connectMongo();
  console.log('[startup] MongoDB connected');

  schedulerTask = scheduleBackupJob();
  warmUpPose(); // load the pose model now, so the first upload does not wait for it

  server = app.listen(config.port, () => {
    console.log(`[startup] Server listening on http://localhost:${config.port}`);
  });
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received, finishing in-flight requests...`);
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    if (schedulerTask) schedulerTask.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    shutdownPose();
    await pool.end();
    await closeMongo();
  } catch (err) {
    console.error('[shutdown] error:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled rejection:', reason);
});

start().catch((err) => {
  console.error('[startup] Failed to start server:', err.message);
  process.exit(1);
});
