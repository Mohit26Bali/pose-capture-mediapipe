const { query } = require('../db/postgres');

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    mongoImageId: row.mongo_image_id,
    mongoDb: row.mongo_db,
    mongoCollection: row.mongo_collection,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    fileSizeBytes: row.file_size_bytes,
    contentHash: row.content_hash,
    poseDetected: row.pose_detected,
    personCount: row.person_count,
    landmarkCount: row.landmark_count,
    poses: row.keypoints,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(record, client) {
  const runner = client ? client.query.bind(client) : query;
  const result = await runner(
    `INSERT INTO pose_records
       (mongo_image_id, mongo_db, mongo_collection, original_filename,
        content_type, file_size_bytes, content_hash, pose_detected,
        person_count, landmark_count, keypoints)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING *`,
    [
      record.mongoImageId,
      record.mongoDb,
      record.mongoCollection,
      record.originalFilename,
      record.contentType,
      record.fileSizeBytes,
      record.contentHash || null,
      record.poseDetected,
      record.personCount || 0,
      record.landmarkCount,
      record.poses ? JSON.stringify(record.poses) : null,
    ]
  );
  return mapRow(result.rows[0]);
}

async function findAll({ limit = 20, offset = 0, search, poseDetected } = {}) {
  const whereClauses = [];
  const values = [];
  let idx = 1;

  if (search) {
    whereClauses.push(`original_filename ILIKE $${idx}`);
    values.push(`%${search}%`);
    idx += 1;
  }
  if (poseDetected === true || poseDetected === false) {
    whereClauses.push(`pose_detected = $${idx}`);
    values.push(poseDetected);
    idx += 1;
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const result = await query(
    `SELECT * FROM pose_records ${whereSql} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset]
  );
  const countResult = await query(
    `SELECT COUNT(*)::int AS total FROM pose_records ${whereSql}`,
    values
  );
  return {
    records: result.rows.map(mapRow),
    total: countResult.rows[0].total,
  };
}

async function findById(id) {
  const result = await query('SELECT * FROM pose_records WHERE id = $1', [id]);
  return mapRow(result.rows[0]);
}

async function findByContentHash(contentHash) {
  if (!contentHash) return null;
  const result = await query('SELECT * FROM pose_records WHERE content_hash = $1', [contentHash]);
  return mapRow(result.rows[0]);
}

async function update(id, fields) {
  const columnMap = {
    originalFilename: 'original_filename',
    poseDetected: 'pose_detected',
    personCount: 'person_count',
    landmarkCount: 'landmark_count',
    poses: 'keypoints',
  };

  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, column] of Object.entries(columnMap)) {
    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      setClauses.push(`${column} = $${idx}`);
      values.push(key === 'poses' && fields[key] !== null ? JSON.stringify(fields[key]) : fields[key]);
      idx += 1;
    }
  }

  if (setClauses.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await query(
    `UPDATE pose_records SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return mapRow(result.rows[0]);
}

async function remove(id) {
  const result = await query('DELETE FROM pose_records WHERE id = $1 RETURNING *', [id]);
  return mapRow(result.rows[0]);
}

module.exports = { create, findAll, findById, findByContentHash, update, remove };
