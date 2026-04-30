-- Normalize recording port assignments: 1 plan item -> 1..2 ports (primary, optional backup).
-- Replaces single `recording_port` column with a relational `ingest_plan_item_ports` table,
-- giving DB-level guarantees for cross-role overlap detection (Ana × Yedek port aynı anda
-- meşgul olamaz). Single GiST exclusion constraint covers all overlap scenarios since
-- "is this port busy" is role-independent.

-- 1. Yeni tablo
CREATE TABLE "ingest_plan_item_ports" (
  "id"                   SERIAL PRIMARY KEY,
  "plan_item_id"         INTEGER     NOT NULL,
  "port_name"            VARCHAR(50) NOT NULL,
  "role"                 VARCHAR(20) NOT NULL,
  -- Denormalized fields: ana tablodan kopyalanır, app layer transaction içinde sync tutar.
  -- GiST exclusion constraint için gerekli (constraint JOIN desteklemiyor).
  "day_date"             DATE        NOT NULL,
  "planned_start_minute" INTEGER     NOT NULL,
  "planned_end_minute"   INTEGER     NOT NULL,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ingest_plan_item_ports_role_check"
    CHECK ("role" IN ('primary', 'backup')),
  CONSTRAINT "ingest_plan_item_ports_time_check"
    CHECK ("planned_start_minute" < "planned_end_minute"),
  CONSTRAINT "ingest_plan_item_ports_plan_item_fk"
    FOREIGN KEY ("plan_item_id") REFERENCES "ingest_plan_items"("id")
    ON UPDATE CASCADE ON DELETE CASCADE
);

-- Her item için en fazla 1 primary, 1 backup
CREATE UNIQUE INDEX "ingest_plan_item_ports_role_unique"
  ON "ingest_plan_item_ports" ("plan_item_id", "role");

-- Aynı port aynı item'da hem primary hem backup olamaz
CREATE UNIQUE INDEX "ingest_plan_item_ports_port_per_item_unique"
  ON "ingest_plan_item_ports" ("plan_item_id", "port_name");

-- Read performansı için
CREATE INDEX "ingest_plan_item_ports_plan_item_idx"
  ON "ingest_plan_item_ports" ("plan_item_id");
CREATE INDEX "ingest_plan_item_ports_day_idx"
  ON "ingest_plan_item_ports" ("day_date", "port_name");

-- Cross-role overlap exclusion: aynı port + aynı gün + kesişen zaman aralığı yasak
-- (rol farkı önemli değil — port meşgulse meşguldür)
ALTER TABLE "ingest_plan_item_ports"
  ADD CONSTRAINT "ingest_plan_item_ports_no_overlap"
  EXCLUDE USING gist (
    "port_name" WITH =,
    "day_date"  WITH =,
    int4range("planned_start_minute", "planned_end_minute", '[)') WITH &&
  );

-- 2. Mevcut data'yı taşı: ingest_plan_items.recording_port -> yeni tabloda role='primary'
INSERT INTO "ingest_plan_item_ports"
  ("plan_item_id", "port_name", "role", "day_date", "planned_start_minute", "planned_end_minute", "updated_at")
SELECT
  "id",
  "recording_port",
  'primary',
  "day_date",
  "planned_start_minute",
  "planned_end_minute",
  CURRENT_TIMESTAMP
FROM "ingest_plan_items"
WHERE "recording_port" IS NOT NULL
  AND "planned_start_minute" IS NOT NULL
  AND "planned_end_minute"   IS NOT NULL;

-- 3. Eski constraint ve kolonu kaldır
ALTER TABLE "ingest_plan_items" DROP CONSTRAINT IF EXISTS "no_port_time_overlap";
ALTER TABLE "ingest_plan_items" DROP COLUMN IF EXISTS "recording_port";

-- 4. Defansif strip: schedules.metadata.liveDetails.recordLocation artık tek kaynak değil.
-- Ingest tarafından okunmalı. Mevcut data'da 0/110 dolu (önceki audit), yine de idempotent silinir.
UPDATE "schedules"
SET "metadata" = jsonb_set(
  "metadata",
  '{liveDetails}',
  ("metadata"->'liveDetails') - 'recordLocation'
)
WHERE "metadata" ? 'liveDetails'
  AND jsonb_typeof("metadata"->'liveDetails') = 'object'
  AND ("metadata"->'liveDetails') ? 'recordLocation';
