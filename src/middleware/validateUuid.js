const { ApiError } = require('./errorHandler');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUuidParam(paramName = 'id') {
  return (req, res, next) => {
    if (!UUID_REGEX.test(req.params[paramName])) {
      next(new ApiError(400, `Invalid ${paramName}: must be a UUID`));
      return;
    }
    next();
  };
}

module.exports = validateUuidParam;
