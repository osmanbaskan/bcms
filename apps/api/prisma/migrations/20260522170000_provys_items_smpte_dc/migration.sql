-- Provys İçerik Kontrol (2026-05-22): SMPTE timecode raw + DC house code.
-- Tüm yeni alanlar nullable — eski kayıtlar UI tarafında fallback ile render.

ALTER TABLE "provys_items"
  ADD COLUMN "start_timecode"    VARCHAR(20),
  ADD COLUMN "duration_timecode" VARCHAR(20),
  ADD COLUMN "frame_rate"        INTEGER,
  ADD COLUMN "dc_code"           VARCHAR(40);
