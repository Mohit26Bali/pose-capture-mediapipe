const config = require('../config/env');
const { ApiError } = require('../middleware/errorHandler');
const { cleanFilename } = require('./imageCheck');

const LANDMARKS_PER_PERSON = 33;
const MAX_OFFSET = 1_000_000;

function whole(value, name, { min, max, fallback }) {
  if (value === undefined || value === '') return fallback;
  if (typeof value !== 'string' || !/^-?\d{1,9}$/.test(value)) {
    throw new ApiError(400, `${name} must be a whole number.`);
  }
  const n = Number(value);
  if (n < min || n > max) throw new ApiError(400, `${name} must be between ${min} and ${max}.`);
  return n;
}

/** GET /records query string -> safe values. Anything out of range is a 400, never a database error. */
function parseListQuery(query) {
  const limit = whole(query.limit, 'limit', { min: 1, max: 100, fallback: 20 });
  const offset = whole(query.offset, 'offset', { min: 0, max: MAX_OFFSET, fallback: 0 });

  let search;
  if (query.search !== undefined) {
    if (typeof query.search !== 'string') throw new ApiError(400, 'search must be text.');
    const trimmed = query.search.trim();
    if (trimmed.length > 100) throw new ApiError(400, 'search must be 100 characters or fewer.');
    // % and _ are wildcards in ILIKE; a search for "50%" means the characters, so escape them.
    search = trimmed ? trimmed.replace(/[\\%_]/g, (c) => `\\${c}`) : undefined;
  }

  let poseDetected;
  if (query.poseDetected !== undefined && query.poseDetected !== '') {
    if (query.poseDetected === 'true') poseDetected = true;
    else if (query.poseDetected === 'false') poseDetected = false;
    else throw new ApiError(400, 'poseDetected must be "true" or "false".');
  }

  return { limit, offset, search, poseDetected };
}

const isNum = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function validatePoses(poses) {
  if (poses === null) return null;
  if (!Array.isArray(poses)) throw new ApiError(400, 'poses must be a list of people, or null.');
  if (poses.length > config.python.maxPeople) {
    throw new ApiError(400, `poses can hold at most ${config.python.maxPeople} people.`);
  }
  return poses.map((person, i) => {
    if (typeof person !== 'object' || person === null || !Array.isArray(person.keypoints)) {
      throw new ApiError(400, `poses[${i}] must have a keypoints list.`);
    }
    if (person.keypoints.length !== LANDMARKS_PER_PERSON) {
      throw new ApiError(400, `poses[${i}].keypoints must have exactly ${LANDMARKS_PER_PERSON} entries.`);
    }
    const keypoints = person.keypoints.map((k, j) => {
      const ok = typeof k === 'object' && k !== null && Number.isInteger(k.index) && k.index === j
        && typeof k.name === 'string' && k.name.length <= 40
        && isNum(k.x, -2, 3) && isNum(k.y, -2, 3) && isNum(k.z, -10, 10) && isNum(k.visibility, 0, 1);
      if (!ok) {
        throw new ApiError(400, `poses[${i}].keypoints[${j}] must be {index: ${j}, name, x, y, z, visibility} with numbers in range.`);
      }
      return { index: k.index, name: k.name, x: k.x, y: k.y, z: k.z, visibility: k.visibility };
    });
    return { personIndex: i, keypoints };
  });
}

/**
 * PATCH/PUT body -> the fields to write. The stored counts must agree with the stored keypoints, so
 * they are derived from `poses` when it is sent, and are rejected when they disagree with it.
 */
function parseUpdateBody(body, existing) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'Send a JSON object.');
  }
  const allowed = ['originalFilename', 'poseDetected', 'personCount', 'landmarkCount', 'poses'];
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  const present = allowed.filter((k) => Object.prototype.hasOwnProperty.call(body, k));
  if (present.length === 0) {
    throw new ApiError(400, `No updatable fields provided. Allowed: ${allowed.join(', ')}`);
  }
  if (unknown.length) throw new ApiError(400, `Unknown fields: ${unknown.slice(0, 5).join(', ')}`);

  const updates = {};

  if (present.includes('originalFilename')) {
    if (typeof body.originalFilename !== 'string') throw new ApiError(400, 'originalFilename must be text.');
    updates.originalFilename = cleanFilename(body.originalFilename);
  }

  if (present.includes('poses')) {
    const poses = validatePoses(body.poses);
    const count = poses ? poses.length : 0;
    updates.poses = poses && poses.length ? poses : null;
    updates.personCount = count;
    updates.landmarkCount = count * LANDMARKS_PER_PERSON;
    updates.poseDetected = count > 0;
  }

  // Counts and the flag may be sent on their own only if they agree with the keypoints that will be stored.
  const finalCount = updates.personCount !== undefined ? updates.personCount : existing.personCount;
  const expect = {
    personCount: finalCount,
    landmarkCount: finalCount * LANDMARKS_PER_PERSON,
    poseDetected: finalCount > 0,
  };
  for (const field of ['personCount', 'landmarkCount', 'poseDetected']) {
    if (!present.includes(field)) continue;
    const given = body[field];
    const wrongType = field === 'poseDetected' ? typeof given !== 'boolean' : !Number.isInteger(given);
    if (wrongType || given !== expect[field]) {
      throw new ApiError(400, `${field} must match the stored keypoints (expected ${expect[field]}). Send "poses" to change them.`);
    }
  }
  return updates;
}

module.exports = { parseListQuery, parseUpdateBody, LANDMARKS_PER_PERSON };
