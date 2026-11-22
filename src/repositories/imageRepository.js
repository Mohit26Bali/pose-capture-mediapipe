const { ObjectId } = require('mongodb');
const { getDb } = require('../db/mongo');
const config = require('../config/env');

function collection() {
  return getDb().collection(config.mongo.imageCollection);
}

async function saveImage({ buffer, originalFilename, contentType }) {
  const doc = {
    data: buffer,
    originalFilename,
    contentType,
    sizeBytes: buffer.length,
    uploadedAt: new Date(),
  };
  const result = await collection().insertOne(doc);
  return result.insertedId.toHexString();
}

async function getImageById(id) {
  if (!ObjectId.isValid(id)) return null;
  return collection().findOne({ _id: new ObjectId(id) });
}

async function deleteImageById(id) {
  if (!ObjectId.isValid(id)) return false;
  const result = await collection().deleteOne({ _id: new ObjectId(id) });
  return result.deletedCount === 1;
}

module.exports = { saveImage, getImageById, deleteImageById };
