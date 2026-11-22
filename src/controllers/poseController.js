const sharp = require('sharp');
const asyncHandler = require('../utils/asyncHandler');
const { ApiError } = require('../middleware/errorHandler');
const poseRecordService = require('../services/poseRecordService');
const poseRecordRepository = require('../repositories/poseRecordRepository');
const imageRepository = require('../repositories/imageRepository');
const { parseListQuery, parseUpdateBody } = require('../utils/validators');

const THUMBNAIL_MAX_DIMENSION = 96;

const extractPose = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'No image file provided. Use multipart/form-data with field name "image".');
  }

  const { record, imageMeta, duplicate } = await poseRecordService.processUpload(req.file);

  let message;
  if (duplicate) {
    message = 'This exact image was already uploaded — returning the existing record instead of creating a duplicate.';
  } else if (record.poseDetected) {
    message = record.personCount > 1
      ? `Pose extracted successfully for ${record.personCount} people`
      : 'Pose extracted successfully';
  } else {
    message = 'Image processed successfully, but no human pose was detected';
  }

  res.status(201).json({
    message,
    duplicate: Boolean(duplicate),
    record: {
      id: record.id,
      poseDetected: record.poseDetected,
      personCount: record.personCount,
      landmarkCount: record.landmarkCount,
      poses: record.poses,
      originalFilename: record.originalFilename,
      contentType: record.contentType,
      fileSizeBytes: record.fileSizeBytes,
      imageWidth: imageMeta ? imageMeta.width : undefined,
      imageHeight: imageMeta ? imageMeta.height : undefined,
      createdAt: record.createdAt,
      image: {
        mongoImageId: record.mongoImageId,
        mongoDb: record.mongoDb,
        mongoCollection: record.mongoCollection,
        url: `/records/${record.id}/image`,
      },
    },
  });
});

const listRecords = asyncHandler(async (req, res) => {
  const { limit, offset, search, poseDetected } = parseListQuery(req.query);
  const { records, total } = await poseRecordRepository.findAll({ limit, offset, search, poseDetected });
  res.status(200).json({ total, limit, offset, records });
});

const getRecord = asyncHandler(async (req, res) => {
  const record = await poseRecordRepository.findById(req.params.id);
  if (!record) {
    throw new ApiError(404, `No record found with id ${req.params.id}`);
  }
  res.status(200).json({ record });
});

const getRecordImage = asyncHandler(async (req, res) => {
  const record = await poseRecordRepository.findById(req.params.id);
  if (!record) {
    throw new ApiError(404, `No record found with id ${req.params.id}`);
  }
  const image = await imageRepository.getImageById(record.mongoImageId);
  if (!image) {
    throw new ApiError(404, 'Original image not found in MongoDB');
  }
  const raw = image.data;
  const imageBuffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer ? raw.buffer : raw);

  // The ORIGINAL image bytes are always what's stored in MongoDB (per the
  // assignment). A thumbnail is generated on the fly here purely for
  // cheaper transfer in the records table UI - it's never persisted.
  if (req.query.thumbnail === 'true') {
    try {
      const thumbnailBuffer = await sharp(imageBuffer)
        .resize(THUMBNAIL_MAX_DIMENSION, THUMBNAIL_MAX_DIMENSION, { fit: 'cover' })
        .jpeg({ quality: 70 })
        .toBuffer();
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).send(thumbnailBuffer);
      return;
    } catch (err) {
      // Fall through to serving the original if thumbnailing fails for any reason.
      console.warn(`[getRecordImage] thumbnail generation failed for ${req.params.id}:`, err.message);
    }
  }

  res.setHeader('Content-Type', image.contentType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(imageBuffer);
});

const updateRecord = asyncHandler(async (req, res) => {
  const existing = await poseRecordRepository.findById(req.params.id);
  if (!existing) {
    throw new ApiError(404, `No record found with id ${req.params.id}`);
  }

  const updates = parseUpdateBody(req.body, existing);
  const record = await poseRecordRepository.update(req.params.id, updates);
  res.status(200).json({ message: 'Record updated', record });
});

const deleteRecord = asyncHandler(async (req, res) => {
  const existing = await poseRecordRepository.findById(req.params.id);
  if (!existing) {
    throw new ApiError(404, `No record found with id ${req.params.id}`);
  }

  await poseRecordRepository.remove(req.params.id);
  await imageRepository.deleteImageById(existing.mongoImageId).catch((err) => {
    // The row is already gone; the image is now an orphan. Log its id so it can be removed by hand.
    console.warn(`[deleteRecord] ORPHANED Mongo image ${existing.mongoImageId} could not be deleted:`, err.message);
  });

  res.status(200).json({ message: 'Record deleted', id: req.params.id });
});

module.exports = { extractPose, listRecords, getRecord, getRecordImage, updateRecord, deleteRecord };
