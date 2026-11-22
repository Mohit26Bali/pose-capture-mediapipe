const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const archiver = require('archiver');
const config = require('../config/env');
const { ApiError } = require('../middleware/errorHandler');
const { sendBackupEmail, sendBackupFailureEmail } = require('./emailService');
const { getDb } = require('../db/mongo');

const execFileAsync = promisify(execFile);

function todayDateString(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Tool output can echo the connection string (and its password) back. Backup errors are logged,
 * returned by the API and emailed, so anything that looks like credentials is removed first.
 */
function redact(text) {
  return String(text || '')
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1***@')
    .replace(/(password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=***')
    .slice(0, 1500);
}

async function dumpPostgres(destDir) {
  const sqlFile = path.join(destDir, 'postgres_dump.sql');
  try {
    await execFileAsync(config.postgres.dumpPath, [
      '-h', config.postgres.host,
      '-p', String(config.postgres.port),
      '-U', config.postgres.user,
      '-F', 'p',
      '-f', sqlFile,
      config.postgres.database,
    ], {
      env: { ...process.env, PGPASSWORD: config.postgres.password },
    });
  } catch (err) {
    throw new Error(`pg_dump failed: ${redact(err.stderr || err.message)}`);
  }
  const stats = await fs.stat(sqlFile);
  if (stats.size === 0) {
    throw new Error('pg_dump produced an empty file');
  }
  return sqlFile;
}

/**
 * The MongoDB URI normally holds a password. Passing it as a command-line argument would expose it to
 * every other user on the machine (process lists), so it goes in a private config file instead. The
 * file lives OUTSIDE the directory that gets zipped, and is removed as soon as mongodump ends.
 */
async function dumpMongo(destDir) {
  const mongoOutDir = path.join(destDir, 'mongo_dump');
  await fs.mkdir(config.backup.tmpDir, { recursive: true });
  const configFile = path.join(config.backup.tmpDir, `mongodump-${process.pid}-${Date.now()}.yml`);
  await fs.writeFile(configFile, `uri: ${JSON.stringify(config.mongo.uri)}\n`, { mode: 0o600 });
  try {
    await execFileAsync(config.mongo.mongodumpPath, [
      `--config=${configFile}`,
      `--db=${config.mongo.dbName}`,
      `--out=${mongoOutDir}`,
    ]);
  } catch (err) {
    throw new Error(`mongodump failed: ${redact(err.stderr || err.message)}`);
  } finally {
    await fs.rm(configFile, { force: true });
  }

  if (!fsSync.existsSync(mongoOutDir)) {
    // mongodump writes nothing for a database with no collections (a fresh install before the first
    // upload). That is a valid, empty backup, not a failure; say so in the archive.
    const count = await getDb().collection(config.mongo.imageCollection).estimatedDocumentCount().catch(() => -1);
    if (count !== 0) throw new Error('mongodump did not produce an output directory');
    await fs.mkdir(mongoOutDir, { recursive: true });
    await fs.writeFile(path.join(mongoOutDir, 'EMPTY.txt'), 'The MongoDB images collection was empty at backup time.\n');
  }
  return mongoOutDir;
}

function zipDirectory(sourceDir, outputZipPath) {
  return new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(outputZipPath);
    // Photos are already compressed (JPEG/PNG/WebP); level 9 would only burn CPU on them.
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve());
    output.on('error', (err) => reject(err));
    archive.on('error', (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

async function removeDirIfExists(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
}

const BACKUP_ZIP_NAME_RE = /^(\d{4}-\d{2}-\d{2})-backup\.zip$/;

/**
 * Deletes backup ZIPs older than `retentionDays` (parsed from the filename's
 * own date, not file mtime, so it survives copies/restores). Disabled when
 * retentionDays <= 0. Best-effort: a deletion failure is logged, not thrown -
 * it must never fail the backup that just succeeded.
 * Returns the list of deleted filenames.
 */
async function applyRetentionPolicy() {
  if (!config.backup.retentionDays || config.backup.retentionDays <= 0) {
    return [];
  }

  const cutoff = Date.now() - config.backup.retentionDays * 24 * 60 * 60 * 1000;
  const deleted = [];

  let entries;
  try {
    entries = await fs.readdir(config.backup.dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const match = entry.match(BACKUP_ZIP_NAME_RE);
    if (!match) continue;

    const fileDate = new Date(`${match[1]}T00:00:00`);
    if (Number.isNaN(fileDate.getTime()) || fileDate.getTime() >= cutoff) continue;

    const fullPath = path.join(config.backup.dir, entry);
    try {
      await fs.unlink(fullPath);
      deleted.push(entry);
    } catch (err) {
      console.warn(`[backup] failed to delete old backup ${entry} during retention cleanup:`, err.message);
    }
  }

  return deleted;
}

let running = null;

const LOCK_STALE_MS = 60 * 60 * 1000;

/**
 * The in-process flag stops two backups inside one server. This file lock also stops "npm run backup"
 * (a separate process) from running while the server's own backup is in progress; both would write the
 * same dated temp directory. A lock older than an hour is treated as left behind by a crash.
 */
async function acquireLock() {
  const lockPath = path.join(config.backup.dir, '.backup.lock');
  await fs.mkdir(config.backup.dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}
`);
      await handle.close();
      return async () => fs.rm(lockPath, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      throw new ApiError(409, 'A backup is already running (in another process). Try again when it finishes.');
    }
  }
  throw new ApiError(409, 'A backup is already running. Try again when it finishes.');
}

/**
 * Runs the full backup pipeline:
 * 1. pg_dump PostgreSQL -> temp dir
 * 2. mongodump MongoDB  -> temp dir
 * 3. zip temp dir        -> /backups/yyyy-mm-dd-backup.zip
 * 4. verify zip
 * 5. clean up temp dir
 * 6. email notification
 * 7. delete ZIPs older than BACKUP_RETENTION_DAYS
 *
 * Only one backup runs at a time. The nightly job and a manual "Run backup now" share a temp
 * directory named after the date, so a second run starting in the middle of the first one would
 * delete files from under it; it gets a 409 instead.
 *
 * Returns a result summary; never throws for email failures (reported in result instead).
 * DOES throw if the dump/zip steps themselves fail - but first attempts to send a
 * failure-alert email, so a broken nightly backup doesn't fail silently.
 */
function runBackup() {
  if (running) {
    return Promise.reject(new ApiError(409, 'A backup is already running. Try again when it finishes.'));
  }
  running = doBackup().finally(() => {
    running = null;
  });
  return running;
}

async function doBackup() {
  const releaseLock = await acquireLock();
  try {
    return await doBackupLocked();
  } finally {
    await releaseLock();
  }
}

async function doBackupLocked() {
  const dateStr = todayDateString();
  const tmpDir = path.join(config.backup.tmpDir, dateStr);
  const zipPath = path.join(config.backup.dir, `${dateStr}-backup.zip`);
  const partialZip = `${zipPath}.partial`;

  // Start from an empty temp dir: a leftover from a crashed run must not end up in this backup.
  await removeDirIfExists(tmpDir);
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(config.backup.dir, { recursive: true });

  const result = { date: dateStr, zipPath, postgres: null, mongo: null, email: null, deletedOldBackups: [] };

  try {
    try {
      result.postgres = await dumpPostgres(tmpDir);
      result.mongo = await dumpMongo(tmpDir);

      // Write to a temporary name and rename on success, so a crash mid-zip never replaces
      // yesterday's good backup (same date) with a half-written file.
      await fs.rm(partialZip, { force: true });
      await zipDirectory(tmpDir, partialZip);

      const zipStats = await fs.stat(partialZip).catch(() => null);
      if (!zipStats || zipStats.size === 0) {
        throw new Error(`Backup ZIP was not created or is empty at ${zipPath}`);
      }
      await fs.rename(partialZip, zipPath);
      result.zipSizeBytes = zipStats.size;
    } catch (err) {
      await fs.rm(partialZip, { force: true }).catch(() => {});
      const message = redact(err.message);
      await sendBackupFailureEmail({ date: dateStr, errorMessage: message }).catch(() => {});
      throw new ApiError(500, `Backup failed: ${message}`);
    }

    const attach = config.email.attachBackup && result.zipSizeBytes <= config.email.maxAttachmentBytes;
    try {
      result.email = await sendBackupEmail({ date: dateStr, zipPath, zipSizeBytes: result.zipSizeBytes, attach });
    } catch (err) {
      result.email = { sent: false, reason: redact(err.message) };
    }

    result.deletedOldBackups = await applyRetentionPolicy();

    return result;
  } finally {
    await removeDirIfExists(tmpDir);
  }
}

module.exports = { runBackup, todayDateString, applyRetentionPolicy, redact };
