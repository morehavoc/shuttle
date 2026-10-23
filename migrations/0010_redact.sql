-- The viewers' copy of an edited video: the recording with the trimmed and cut parts taken out
-- (src/redact.js). JSON: { sig, state: pending | ready | unsupported | failed, ver, tries, since,
-- claim, error, job, out: { main, cam }, cuts, durationMs }. NULL = no edits, viewers get the file.
ALTER TABLE videos ADD COLUMN redact TEXT;
