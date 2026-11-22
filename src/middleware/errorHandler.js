const multer = require('multer');

/**
 * An error whose message is meant for the client. Anything that is NOT an ApiError (database errors,
 * file-system errors, library failures) is logged in full and answered with a generic message, so
 * connection strings, paths and SQL never reach a response.
 */
class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'NotFound', message: 'No such route.' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    const statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'The image is larger than the upload limit.'
      : 'The upload was not understood. Send one file in the "image" field.';
    return res.status(statusCode).json({ error: err.code, message });
  }

  if (err instanceof ApiError) {
    if (err.statusCode >= 500) console.error('[error]', err.message, err.cause || '');
    return res.status(err.statusCode).json({
      error: err.name,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
  }

  // Errors from body parsers / multer filters that carry their own client-safe status.
  if (err && err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.expose !== false && err.isClientSafe) {
    return res.status(err.statusCode).json({ error: 'BadRequest', message: err.message });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BadRequest', message: 'Request body is not valid JSON.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'PayloadTooLarge', message: 'Request body is too large.' });
  }

  console.error('[error]', err);
  return res.status(500).json({ error: 'InternalError', message: 'Something went wrong on the server.' });
}

module.exports = { ApiError, notFoundHandler, errorHandler };
