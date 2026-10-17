-- The speed a video starts at on its share page (the owner's pick); NULL = the viewer's own last choice.
ALTER TABLE videos ADD COLUMN speed REAL;
