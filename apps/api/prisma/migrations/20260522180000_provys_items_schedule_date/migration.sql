-- Provys İçerik Kontrol (2026-05-22): per-day snapshot mantığına geçiş.
-- Eski sözleşme: kanal başına yalnız "en güncel BXF" tutuluyordu; geçmiş
-- günler erişilemiyordu. Yeni snapshot key: (channel_slug, schedule_date,
-- event_id) — her gün ayrı snapshot, geçmiş günler korunur.
--
-- Eski 1087 satır disposable kabul edildi: scheduleDate backfill TV
-- broadcast day mantığına uymadığı için (gece yarısı sonrası event'leri
-- yanlış güne düşerdi). Worker initial scan dosya tarihine göre yeniden
-- doldurur.

DELETE FROM "provys_items";

ALTER TABLE "provys_items" DROP CONSTRAINT IF EXISTS "provys_items_channel_event_unique";
DROP INDEX IF EXISTS "provys_items_channel_event_unique";
DROP INDEX IF EXISTS "provys_items_channel_seq_idx";

ALTER TABLE "provys_items" ADD COLUMN "schedule_date" DATE NOT NULL;

CREATE UNIQUE INDEX "provys_items_channel_date_event_unique"
  ON "provys_items" ("channel_slug", "schedule_date", "event_id");

CREATE INDEX "provys_items_channel_date_seq_idx"
  ON "provys_items" ("channel_slug", "schedule_date", "sequence");
