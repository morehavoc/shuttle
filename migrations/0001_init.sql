CREATE TABLE videos (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  mode        TEXT NOT NULL DEFAULT 'screen-camera',
  mime        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'recording', -- recording | ready
  upload_id   TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  width       INTEGER NOT NULL DEFAULT 0,
  height      INTEGER NOT NULL DEFAULT 0,
  has_thumb   INTEGER NOT NULL DEFAULT 0,
  views       INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX videos_created ON videos (created_at DESC);

CREATE TABLE parts (
  video_id TEXT NOT NULL,
  n        INTEGER NOT NULL,
  etag     TEXT NOT NULL,
  size     INTEGER NOT NULL,
  PRIMARY KEY (video_id, n)
);
