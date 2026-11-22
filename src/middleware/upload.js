const fs = require('fs');
const multer = require('multer');
const config = require('../config/env');
const { ApiError } = require('./errorHandler');

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/bmp']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Created on demand so a fresh checkout (or a wiped temp dir) never turns uploads into 500s.
    fs.mkdirSync(config.upload.tmpDir, { recursive: true });
    cb(null, config.upload.tmpDir);
  },
  filename: (req, file, cb) => {
    // The stored name never comes from the client (no path tricks); only a safe extension is kept.
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const ext = (file.originalname.match(/\.[a-zA-Z0-9]{1,5}$/) || [''])[0];
    cb(null, `${unique}${ext}`);
  },
});

// A first, cheap filter on the declared type. The real check is on the file's bytes (utils/imageCheck).
function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(new ApiError(415, `Unsupported image type. Allowed: ${[...ALLOWED_MIME_TYPES].join(', ')}`));
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.upload.maxSizeBytes, files: 1, fields: 5, parts: 8 },
});

module.exports = { upload, ALLOWED_MIME_TYPES };
