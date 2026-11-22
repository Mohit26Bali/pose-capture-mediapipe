-- Pose Capture: PostgreSQL schema
-- Stores pose extraction records. The original image bytes live in MongoDB;
-- this table keeps a reference (mongo_image_id) back to that document.
--
-- `keypoints` holds an array of per-person poses (multi-person aware):
--   [ { "person_index": 0, "keypoints": [ {index,name,x,y,z,visibility}, ...33 ] }, ... ]
-- `landmark_count` is the TOTAL landmark count across all detected people
-- (33 * person_count when pose_detected is true).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS pose_records (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Reference to the MongoDB document holding the original image bytes.
    -- Mongo ObjectId is a 24-character hex string.
    mongo_image_id     CHAR(24) NOT NULL,
    mongo_db           TEXT NOT NULL,
    mongo_collection   TEXT NOT NULL,

    original_filename  TEXT,
    content_type       TEXT NOT NULL,
    file_size_bytes     INTEGER,

    -- SHA-256 of the uploaded file's bytes, used to detect duplicate uploads.
    -- Nullable (a unique index that ignores NULLs) so it never blocks rows
    -- created before this column existed.
    content_hash       CHAR(64),

    pose_detected      BOOLEAN NOT NULL DEFAULT FALSE,
    person_count       INTEGER NOT NULL DEFAULT 0,
    landmark_count     INTEGER NOT NULL DEFAULT 0,
    keypoints          JSONB,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Schema evolution for databases created before multi-person support / dedup:
ALTER TABLE pose_records ADD COLUMN IF NOT EXISTS person_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pose_records ADD COLUMN IF NOT EXISTS content_hash CHAR(64);

-- Local/demo rows written before multi-person support used a flat 33-landmark
-- array for `keypoints` (incompatible with the new per-person shape). Rather
-- than attempt a lossy reshape, clear those out - this is disposable local
-- test data, not a real-world migration concern.
DELETE FROM pose_records
WHERE keypoints IS NOT NULL
  AND jsonb_typeof(keypoints) = 'array'
  AND jsonb_array_length(keypoints) > 0
  AND NOT (keypoints -> 0 ? 'person_index');

CREATE INDEX IF NOT EXISTS idx_pose_records_created_at ON pose_records (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pose_records_mongo_image_id ON pose_records (mongo_image_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pose_records_content_hash ON pose_records (content_hash) WHERE content_hash IS NOT NULL;

-- Keep updated_at current on every UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pose_records_updated_at ON pose_records;
CREATE TRIGGER trg_pose_records_updated_at
    BEFORE UPDATE ON pose_records
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
