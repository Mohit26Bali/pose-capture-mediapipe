const fs = require('fs/promises');
const crypto = require('crypto');
const config = require('../config/env');
const imageRepository = require('../repositories/imageRepository');
const poseRecordRepository = require('../repositories/poseRecordRepository');
const { extractPose, PoseExtractionError } = require('./poseExtractionService');
const { ApiError } = require('../middleware/errorHandler');
const { inspectImage, cleanFilename } = require('../utils/imageCheck');

async function safeUnlink(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[poseRecordService] failed to remove temp file ${filePath}:`, err.message);
    }
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const UNIQUE_VIOLATION = '23505';

/**
 * Orchestrates: check the file -> store image in Mongo -> run pose extraction -> store record in Postgres.
 * On any failure after the Mongo write, the Mongo image is rolled back (deleted)
 * so no orphaned data is left behind.
 *
 * If the exact same file bytes were already uploaded before (same SHA-256), the
 * existing record is returned instead of re-processing - avoids duplicate Mongo
 * images, duplicate Postgres rows, and a wasted MediaPipe invocation. Two identical
 * uploads that arrive at the same moment are handled too: the loser of the race hits the
 * unique index, removes its own Mongo copy, and gets the winner's record back.
 */
async function processUpload(file) {
  let mongoImageId;

  try {
    const buffer = await fs.readFile(file.path);
    // What the file REALLY is (not what the client claimed), and whether it is a sane size to decode.
    const detected = await inspectImage(buffer);
    const contentHash = sha256(buffer);
    const filename = cleanFilename(file.originalname);

    const existing = await poseRecordRepository.findByContentHash(contentHash);
    if (existing) {
      return { record: existing, imageMeta: null, duplicate: true };
    }

    try {
      mongoImageId = await imageRepository.saveImage({
        buffer,
        originalFilename: filename,
        contentType: detected.contentType,
      });
    } catch (err) {
      throw new ApiError(502, 'The image could not be stored (MongoDB is unavailable).');
    }

    let poseResult;
    try {
      poseResult = await extractPose(file.path);
    } catch (err) {
      await imageRepository.deleteImageById(mongoImageId).catch(() => {});
      if (err instanceof PoseExtractionError) {
        if (err.type === 'invalid_image') throw new ApiError(422, 'The image could not be read.', { errorType: err.type });
        if (err.type === 'busy') throw new ApiError(503, err.message, { errorType: err.type });
        if (err.type === 'timeout') throw new ApiError(504, 'Pose extraction took too long and was stopped.', { errorType: err.type });
        // environment/processing problems are the server's, not the client's; details go to the log.
        console.error('[pose] extraction failed:', err.type, err.message);
        throw new ApiError(502, 'Pose extraction failed on the server.', { errorType: err.type });
      }
      throw err;
    }

    let record;
    try {
      record = await poseRecordRepository.create({
        mongoImageId,
        mongoDb: config.mongo.dbName,
        mongoCollection: config.mongo.imageCollection,
        originalFilename: filename,
        contentType: detected.contentType,
        fileSizeBytes: buffer.length,
        contentHash,
        poseDetected: poseResult.poseDetected,
        personCount: poseResult.personCount,
        landmarkCount: poseResult.landmarkCount,
        poses: poseResult.poses,
      });
    } catch (err) {
      await imageRepository.deleteImageById(mongoImageId).catch(() => {});
      if (err && err.code === UNIQUE_VIOLATION) {
        const winner = await poseRecordRepository.findByContentHash(contentHash);
        if (winner) return { record: winner, imageMeta: null, duplicate: true };
      }
      console.error('[pose] saving the record failed:', err.message);
      throw new ApiError(502, 'The pose record could not be saved (PostgreSQL is unavailable).');
    }

    return {
      record,
      imageMeta: { width: poseResult.imageWidth, height: poseResult.imageHeight },
      duplicate: false,
    };
  } finally {
    await safeUnlink(file.path);
  }
}

module.exports = { processUpload };
