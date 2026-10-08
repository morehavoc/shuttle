-- A short description (written by the owner, or drafted from the transcript), and an optional
-- expiry: videos past expires_at are hidden at once and deleted by the hourly sweep.
ALTER TABLE videos ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE videos ADD COLUMN description_source TEXT NOT NULL DEFAULT ''; -- '' | working | auto | owner
ALTER TABLE videos ADD COLUMN expires_at INTEGER;
CREATE INDEX IF NOT EXISTS videos_expires ON videos (expires_at) WHERE expires_at IS NOT NULL;
