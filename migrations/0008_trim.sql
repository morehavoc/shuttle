-- Trim: where playback starts and stops, in seconds of the recording. Kept apart from the cuts
-- so neither edit swallows the other. NULL = from the very start / to the very end, however
-- long a browser reads the file to be (they differ by up to half a second).
ALTER TABLE videos ADD COLUMN trim_start REAL;
ALTER TABLE videos ADD COLUMN trim_end REAL;
