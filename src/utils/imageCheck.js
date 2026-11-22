const sharp = require('sharp');
const config = require('../config/env');
const { ApiError } = require('../middleware/errorHandler');

const FORMATS = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

/** What the file really is, from its first bytes. The browser-declared Content-Type is not trusted. */
function sniff(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') return 'bmp';
  return null;
}

/**
 * Checks an uploaded file before any expensive work: it must really be a JPEG, PNG, WebP or BMP, and
 * must not decode to more pixels than MAX_IMAGE_MEGAPIXELS (a few KB of PNG can describe a
 * 100000 x 100000 bitmap and take gigabytes of memory to open).
 * Returns { format, contentType, width, height }.
 */
async function inspectImage(buffer) {
  const format = sniff(buffer);
  if (!format) {
    // The declared type said image, but the bytes are not one (renamed text file, truncated upload, ...).
    throw new ApiError(422, 'The file is not a readable JPEG, PNG, WebP or BMP image.');
  }

  let width;
  let height;
  if (format === 'bmp') {
    const headerSize = buffer.readUInt32LE(14);
    if (headerSize === 12) {
      width = buffer.readUInt16LE(18);
      height = buffer.readUInt16LE(20);
    } else {
      width = buffer.readInt32LE(18);
      height = Math.abs(buffer.readInt32LE(22));
    }
  } else {
    try {
      const meta = await sharp(buffer, { limitInputPixels: false }).metadata(); // header only, nothing is decoded
      width = meta.width;
      height = meta.height;
    } catch {
      throw new ApiError(422, 'The image file is damaged and could not be read.');
    }
  }

  if (!width || !height || width < 1 || height < 1) {
    throw new ApiError(422, 'The image file is damaged and could not be read.');
  }
  if (width * height > config.upload.maxPixels) {
    const mp = Math.round(config.upload.maxPixels / 1_000_000);
    throw new ApiError(413, `The image is too large (${width} x ${height}). The limit is ${mp} megapixels.`);
  }

  return { format, contentType: format === 'bmp' ? 'image/bmp' : FORMATS[format], width, height };
}

/** A filename safe to store and show: no path parts, no control characters, bounded length. */
function cleanFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned || 'upload';
}

module.exports = { inspectImage, cleanFilename, sniff };
