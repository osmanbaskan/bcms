-- Madde 5 M5-B8 (decision sec. 5 + scope lock T1-T12, 2026-05-07):
-- live_plan_transmission_segments — 1:N child of live_plan_entries.
-- Net uydu kullanım pencerelerini (TEST/PROGRAM/HIGHLIGHTS/INTERVIEW/OTHER)
-- her feed (MAIN/BACKUP/FIBER/OTHER) için ayrı kayıt eder.
--
-- FK politikası (T3):
--   - live_plan_entry_id: NOT NULL FK → live_plan_entries(id) ON DELETE CASCADE.
--     Production'da hard-delete yok (live_plan_entries soft-delete kullanır);
--     CASCADE 1:N child anlamlılığı için + test cleanup tutarlılığı.
--
-- DB CHECK (T4/T5/T7):
--   - feed_role IN ('MAIN','BACKUP','FIBER','OTHER')
--   - kind      IN ('TEST','PROGRAM','HIGHLIGHTS','INTERVIEW','OTHER')
--   - end_time > start_time (T6: ikisi de NOT NULL → NULL kombinasyonu yok)
--
-- T9: version kolonu YOK (segment update çakışmaları parent entry version'ı
-- ile kontrol edilir; M5-B9 service ihtiyaç görürse minor PR ekler).
-- T10: deleted_at nullable (soft-delete pattern, audit/recovery için).
-- T11: tek index (live_plan_entry_id, start_time) — entry-bazlı segment
-- listesi en yaygın query.

CREATE TABLE "live_plan_transmission_segments" (
  "id"                 SERIAL PRIMARY KEY,
  "live_plan_entry_id" INTEGER        NOT NULL,
  "feed_role"          VARCHAR(20)    NOT NULL,
  "kind"               VARCHAR(20)    NOT NULL,
  "start_time"         TIMESTAMPTZ(6) NOT NULL,
  "end_time"           TIMESTAMPTZ(6) NOT NULL,
  "description"        TEXT,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deleted_at"         TIMESTAMPTZ(6)
);

-- Parent FK CASCADE (T3)
ALTER TABLE "live_plan_transmission_segments"
  ADD CONSTRAINT "live_plan_transmission_segments_entry_fkey"
  FOREIGN KEY ("live_plan_entry_id") REFERENCES "live_plan_entries"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- T4: feed_role CHECK
ALTER TABLE "live_plan_transmission_segments"
  ADD CONSTRAINT "live_plan_transmission_segments_feed_role_check"
  CHECK ("feed_role" IN ('MAIN','BACKUP','FIBER','OTHER'));

-- T5: kind CHECK
ALTER TABLE "live_plan_transmission_segments"
  ADD CONSTRAINT "live_plan_transmission_segments_kind_check"
  CHECK ("kind" IN ('TEST','PROGRAM','HIGHLIGHTS','INTERVIEW','OTHER'));

-- T7: window CHECK
ALTER TABLE "live_plan_transmission_segments"
  ADD CONSTRAINT "live_plan_transmission_segments_window_check"
  CHECK ("end_time" > "start_time");

-- T11: entry-bazlı liste için tek index
CREATE INDEX "live_plan_transmission_segments_entry_start_idx"
  ON "live_plan_transmission_segments" ("live_plan_entry_id", "start_time");
