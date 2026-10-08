-- The camera is recorded as its own track and composited at playback; edits are cut ranges;
-- transcripts arrive in chunks while recording.
ALTER TABLE videos ADD COLUMN cam_mime TEXT;
ALTER TABLE videos ADD COLUMN cam_upload_id TEXT;
ALTER TABLE videos ADD COLUMN cam_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN cam_offset_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN cam_muted_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN surface TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN layout TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN cuts TEXT NOT NULL DEFAULT '[]';
ALTER TABLE videos ADD COLUMN has_cam_thumb INTEGER NOT NULL DEFAULT 0;
ALTER TABLE videos ADD COLUMN has_og INTEGER NOT NULL DEFAULT 0;

CREATE TABLE parts_v2 (
  video_id TEXT NOT NULL,
  track    TEXT NOT NULL DEFAULT 'main',
  n        INTEGER NOT NULL,
  etag     TEXT NOT NULL,
  size     INTEGER NOT NULL,
  PRIMARY KEY (video_id, track, n)
);
INSERT INTO parts_v2 (video_id, track, n, etag, size) SELECT video_id, 'main', n, etag, size FROM parts;
DROP TABLE parts;
ALTER TABLE parts_v2 RENAME TO parts;

CREATE TABLE transcript_chunks (
  video_id    TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  start_ms    INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | ready | failed | off
  words       TEXT,
  error       TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (video_id, seq)
);
