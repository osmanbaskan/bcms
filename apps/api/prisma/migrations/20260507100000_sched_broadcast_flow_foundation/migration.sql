-- SCHED-B2 (decision §3.5 K16 + REQUIREMENTS §4-§5, 2026-05-07):
-- Schedule/Yayın Planlama broadcast flow + live-plan event_key/source_type
-- foundation. Eski kolonlar (metadata/usage_scope/start_time/end_time/
-- channel_id) bu PR'da DROP edilmez; SCHED-B5 destructive cleanup'a kalır.
--
-- Kapsam:
--   §1 schedules ADD: 12 yeni kolon + UNIQUE event_key + 4 FK + CHECK
--   §2 live_plan_entries ADD: 5 yeni kolon + source_type CHECK + channel
--      slot CHECK + 3 channel FK + event_key index
--   §3 Backfill mevcut live_plan_entries (smoke) — event_key generate
--   §4 3 yeni schedule lookup tablo (M5-B4 paritesi)
--   §5 schedules → 3 lookup FK
--
-- Eski schedule kolonları paralel kalır (yeni path çalışır olduktan sonra
-- SCHED-B5'te DROP).

-- ─────────────────────────────────────────────────────────────────────────────
-- §1 schedules ADD: yeni alanlar
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "schedules"
  ADD COLUMN "event_key"                   VARCHAR(120),
  ADD COLUMN "selected_live_plan_entry_id" INTEGER,
  ADD COLUMN "schedule_date"               DATE,
  ADD COLUMN "schedule_time"               TIME(6),
  ADD COLUMN "team_1_name"                 VARCHAR(200),
  ADD COLUMN "team_2_name"                 VARCHAR(200),
  ADD COLUMN "channel_1_id"                INTEGER,
  ADD COLUMN "channel_2_id"                INTEGER,
  ADD COLUMN "channel_3_id"                INTEGER,
  ADD COLUMN "commercial_option_id"        INTEGER,
  ADD COLUMN "logo_option_id"              INTEGER,
  ADD COLUMN "format_option_id"            INTEGER;

-- UNIQUE event_key (nullable; PostgreSQL multiple NULL kabul eder; B5 sonrası
-- NOT NULL transition ayrı PR).
CREATE UNIQUE INDEX "schedules_event_key_uniq" ON "schedules"("event_key");

-- 3 channel slot duplicate yasak (NULL serbest; iki slot da NOT NULL ise eşit
-- olamaz).
ALTER TABLE "schedules"
  ADD CONSTRAINT "schedules_channel_slots_distinct" CHECK (
    (channel_1_id IS NULL OR channel_2_id IS NULL OR channel_1_id <> channel_2_id) AND
    (channel_1_id IS NULL OR channel_3_id IS NULL OR channel_1_id <> channel_3_id) AND
    (channel_2_id IS NULL OR channel_3_id IS NULL OR channel_2_id <> channel_3_id)
  );

-- 4 yeni FK: 3 channel slot + selected_live_plan_entry_id
ALTER TABLE "schedules"
  ADD CONSTRAINT "schedules_channel_1_id_fkey"
    FOREIGN KEY ("channel_1_id") REFERENCES "channels"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "schedules_channel_2_id_fkey"
    FOREIGN KEY ("channel_2_id") REFERENCES "channels"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "schedules_channel_3_id_fkey"
    FOREIGN KEY ("channel_3_id") REFERENCES "channels"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "schedules_selected_live_plan_entry_id_fkey"
    FOREIGN KEY ("selected_live_plan_entry_id") REFERENCES "live_plan_entries"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- §2 live_plan_entries ADD: event_key + source_type + 3 channel slot
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "live_plan_entries"
  ADD COLUMN "event_key"     VARCHAR(120),
  ADD COLUMN "source_type"   VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "channel_1_id"  INTEGER,
  ADD COLUMN "channel_2_id"  INTEGER,
  ADD COLUMN "channel_3_id"  INTEGER;

-- source_type CHECK (K18: 'OPTA' | 'MANUAL')
ALTER TABLE "live_plan_entries"
  ADD CONSTRAINT "live_plan_entries_source_type_check"
    CHECK ("source_type" IN ('OPTA','MANUAL'));

-- 3 channel slot duplicate yasak (entries pattern; aynı schedules ile)
ALTER TABLE "live_plan_entries"
  ADD CONSTRAINT "live_plan_entries_channel_slots_distinct" CHECK (
    (channel_1_id IS NULL OR channel_2_id IS NULL OR channel_1_id <> channel_2_id) AND
    (channel_1_id IS NULL OR channel_3_id IS NULL OR channel_1_id <> channel_3_id) AND
    (channel_2_id IS NULL OR channel_3_id IS NULL OR channel_2_id <> channel_3_id)
  );

-- 3 channel FK
ALTER TABLE "live_plan_entries"
  ADD CONSTRAINT "live_plan_entries_channel_1_id_fkey"
    FOREIGN KEY ("channel_1_id") REFERENCES "channels"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "live_plan_entries_channel_2_id_fkey"
    FOREIGN KEY ("channel_2_id") REFERENCES "channels"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "live_plan_entries_channel_3_id_fkey"
    FOREIGN KEY ("channel_3_id") REFERENCES "channels"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- event_key non-unique partial index (channel propagation lookup için).
CREATE INDEX "live_plan_entries_event_key_idx"
  ON "live_plan_entries"("event_key")
  WHERE "event_key" IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- §3 Backfill: mevcut live_plan_entries (2 smoke satır)
-- ─────────────────────────────────────────────────────────────────────────────

-- opta_match_id NULL → source_type='MANUAL' (default zaten); event_key generate
UPDATE "live_plan_entries"
SET "event_key" = 'manual:' || gen_random_uuid()::text
WHERE "event_key" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- §4 Schedule lookup tabloları (3 yeni; M5-B4 paritesi)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE "schedule_commercial_options" (
  "id"          SERIAL PRIMARY KEY,
  "label"       VARCHAR(200)   NOT NULL,
  "active"      BOOLEAN        NOT NULL DEFAULT TRUE,
  "sort_order"  INTEGER        NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deleted_at"  TIMESTAMPTZ(6)
);
ALTER TABLE "schedule_commercial_options"
  ADD CONSTRAINT "schedule_commercial_options_label_not_blank"
    CHECK (length(trim("label")) > 0);
CREATE UNIQUE INDEX "schedule_commercial_options_label_uniq"
  ON "schedule_commercial_options"(LOWER("label"))
  WHERE "deleted_at" IS NULL;

CREATE TABLE "schedule_logo_options" (
  "id"          SERIAL PRIMARY KEY,
  "label"       VARCHAR(200)   NOT NULL,
  "active"      BOOLEAN        NOT NULL DEFAULT TRUE,
  "sort_order"  INTEGER        NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deleted_at"  TIMESTAMPTZ(6)
);
ALTER TABLE "schedule_logo_options"
  ADD CONSTRAINT "schedule_logo_options_label_not_blank"
    CHECK (length(trim("label")) > 0);
CREATE UNIQUE INDEX "schedule_logo_options_label_uniq"
  ON "schedule_logo_options"(LOWER("label"))
  WHERE "deleted_at" IS NULL;

CREATE TABLE "schedule_format_options" (
  "id"          SERIAL PRIMARY KEY,
  "label"       VARCHAR(200)   NOT NULL,
  "active"      BOOLEAN        NOT NULL DEFAULT TRUE,
  "sort_order"  INTEGER        NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "deleted_at"  TIMESTAMPTZ(6)
);
ALTER TABLE "schedule_format_options"
  ADD CONSTRAINT "schedule_format_options_label_not_blank"
    CHECK (length(trim("label")) > 0);
CREATE UNIQUE INDEX "schedule_format_options_label_uniq"
  ON "schedule_format_options"(LOWER("label"))
  WHERE "deleted_at" IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- §5 schedules → 3 lookup FK (RESTRICT; admin lookup soft-delete kullanır)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "schedules"
  ADD CONSTRAINT "schedules_commercial_option_id_fkey"
    FOREIGN KEY ("commercial_option_id") REFERENCES "schedule_commercial_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "schedules_logo_option_id_fkey"
    FOREIGN KEY ("logo_option_id") REFERENCES "schedule_logo_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "schedules_format_option_id_fkey"
    FOREIGN KEY ("format_option_id") REFERENCES "schedule_format_options"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
