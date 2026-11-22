const config = require('../config/env');
const { ApiError } = require('./errorHandler');

/** Sliding-window limiter, in memory (one process). */
class RateLimiter {
  constructor(limit, windowMs, maxKeys = 5000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  allow(key, now = Date.now()) {
    if (this.hits.size > this.maxKeys) {
      // A flood of invented keys must not grow memory without bound.
      for (const [k, v] of this.hits) {
        if (!v.length || now - v[v.length - 1] >= this.windowMs) this.hits.delete(k);
      }
    }
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  retryAfterSeconds(key, now = Date.now()) {
    const first = (this.hits.get(key) || [])[0];
    return first === undefined ? 1 : Math.max(1, Math.ceil((this.windowMs - (now - first)) / 1000));
  }
}

/**
 * The visitor's address. X-Forwarded-For is believed only when TRUSTED_PROXY_HOPS says how many
 * proxies sit in front of the app; with 0, a visitor could invent a new address on every request.
 */
function clientKey(req, hops = config.security.trustedProxyHops) {
  if (hops > 0) {
    const parts = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= hops) return parts[parts.length - hops];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function limit(limiter, message) {
  return (req, res, next) => {
    const key = clientKey(req);
    if (!limiter.allow(key)) {
      res.setHeader('Retry-After', String(limiter.retryAfterSeconds(key)));
      next(new ApiError(429, message));
      return;
    }
    next();
  };
}

const uploadLimiter = new RateLimiter(config.security.uploadsPerMinute, 60_000);
const readLimiter = new RateLimiter(config.security.readsPerMinute, 60_000);
const backupLimiter = new RateLimiter(config.security.backupsPerHour, 60 * 60_000);

module.exports = {
  RateLimiter,
  clientKey,
  limitUploads: limit(uploadLimiter, 'Too many uploads. Please wait a moment and try again.'),
  limitReads: limit(readLimiter, 'Too many requests. Please wait a moment and try again.'),
  limitBackups: limit(backupLimiter, 'Too many backup requests. Try again later.'),
  limiters: { uploadLimiter, readLimiter, backupLimiter },
};
