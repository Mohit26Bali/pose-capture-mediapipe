/**
 * Re-runs pose extraction over every stored image and updates the keypoints.
 *
 * Why this exists: records are computed once, at upload. When the extraction improves (a new model, the
 * tiling that finds small people, changed thresholds), old records keep their old results, and uploading
 * the same photo again just returns the stored one (it is a duplicate). This is the way to bring them up
 * to date.
 *
 *   npm run reprocess -- --dry-run     show what would change, write nothing
 *   npm run reprocess                  update the records
 */
const fs = require('fs/promises');
const path = require('path');
const config = require('../config/env');
const { pool } = require('../db/postgres');
const { connectMongo, closeMongo } = require('../db/mongo');
const poseRecordRepository = require('../repositories/poseRecordRepository');
const imageRepository = require('../repositories/imageRepository');
const { extractPose, shutdownPose } = require('../services/poseExtractionService');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  await connectMongo();
  await fs.mkdir(config.upload.tmpDir, { recursive: true });

  let offset = 0;
  const pageSize = 50;
  const summary = { checked: 0, changed: 0, failed: 0, peopleBefore: 0, peopleAfter: 0 };

  for (;;) {
    const { records } = await poseRecordRepository.findAll({ limit: pageSize, offset });
    if (records.length === 0) break;
    for (const record of records) {
      summary.checked += 1;
      const tmpFile = path.join(config.upload.tmpDir, `reprocess-${record.id}`);
      try {
        const image = await imageRepository.getImageById(record.mongoImageId);
        if (!image) throw new Error('image missing in MongoDB');
        const raw = image.data;
        await fs.writeFile(tmpFile, Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer));
        const result = await extractPose(tmpFile);

        summary.peopleBefore += record.personCount;
        summary.peopleAfter += result.personCount;
        if (result.personCount !== record.personCount) {
          summary.changed += 1;
          console.log(`${record.id} ${record.originalFilename}: ${record.personCount} -> ${result.personCount} people`);
        }
        if (!dryRun) {
          await poseRecordRepository.update(record.id, {
            poseDetected: result.poseDetected,
            personCount: result.personCount,
            landmarkCount: result.landmarkCount,
            poses: result.poses,
          });
        }
      } catch (err) {
        summary.failed += 1;
        console.warn(`${record.id}: skipped (${err.message})`);
      } finally {
        await fs.rm(tmpFile, { force: true });
      }
    }
    offset += pageSize;
  }

  console.log(JSON.stringify({ dryRun, ...summary }, null, 2));
  shutdownPose();
  await pool.end();
  await closeMongo();
}

main().catch((err) => {
  console.error('[reprocess] failed:', err.message);
  process.exit(1);
});
