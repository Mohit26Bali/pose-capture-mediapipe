const crypto = require('crypto');
const config = require('../config/env');
const { ApiError } = require('./errorHandler');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb); // equal length by construction, and no early exit on the first wrong byte
}

function presentedKey(req) {
  const header = req.headers.authorization;
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const alt = req.headers['x-api-key'];
  return typeof alt === 'string' ? alt.trim() : '';
}

/**
 * Requires the shared API key when one is configured (API_KEY). With no key configured the API is
 * open, which server.js only allows outside production.
 */
function requireApiKey(req, res, next) {
  const expected = config.security.apiKey;
  if (!expected) {
    next();
    return;
  }
  const given = presentedKey(req);
  if (!given || !safeEqual(given, expected)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="pose-capture"');
    next(new ApiError(401, 'A valid API key is required. Send it as "Authorization: Bearer <key>" or "x-api-key".'));
    return;
  }
  next();
}

module.exports = { requireApiKey, safeEqual };
