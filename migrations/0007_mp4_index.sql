-- Fragment index (sidx) per track, spliced into the served file so Chrome can start without
-- walking every fragment. JSON: {"main": {"at", "etag", "sidx": base64} | {"none": true, "etag"}, "cam": ...}
ALTER TABLE videos ADD COLUMN mp4_index TEXT;
