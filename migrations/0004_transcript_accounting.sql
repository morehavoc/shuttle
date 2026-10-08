-- How many transcript chunks the recorder produced (-1 = unknown, older recordings), so a chunk
-- that never arrived shows as a gap instead of a complete transcript; and how much audio the
-- transcript tap missed.
ALTER TABLE videos ADD COLUMN audio_chunks INTEGER NOT NULL DEFAULT -1;
ALTER TABLE videos ADD COLUMN tap_gap_ms INTEGER NOT NULL DEFAULT 0;
