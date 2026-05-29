-- Restore V2 — 3 kademe modeline geçiş delta (audit doc).
--
-- Önceki migration (20260528120000): restore_jobs + transfer_jobs base.
-- Bu delta: search_jobs (kademe 1) + restore/transfer'a asset bilgisi
-- kolonları (search → restore → transfer kopyalama akışı).
--
-- Idempotency: search_jobs partial unique active-only (QUEUED/RUNNING/
-- AWAITING_SELECTION). Restore + transfer'da değişmedi.

-- ============================================================================
-- Kademe 1: search_jobs (yeni)
-- ============================================================================

CREATE TYPE "search_job_status" AS ENUM (
  'QUEUED',
  'RUNNING',
  'AWAITING_SELECTION',
  'SELECTED',
  'NOT_FOUND',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "search_jobs" (
  "id"                  SERIAL                  PRIMARY KEY,
  "dc_code"             VARCHAR(40)             NOT NULL,
  "channel_slug"        VARCHAR(30)             NOT NULL,
  "schedule_date"       DATE                    NOT NULL,
  "status"              "search_job_status"     NOT NULL DEFAULT 'QUEUED',
  "attempt_count"       INTEGER                 NOT NULL DEFAULT 0,
  "max_attempts"        INTEGER                 NOT NULL DEFAULT 3,
  -- AvidAsset[] dizisi JSONB. AWAITING_SELECTION'da dolu; NOT_FOUND iken [];
  -- FAILED iken null. PATCH select endpoint whitelist check için okunur.
  "avid_assets"         JSONB,
  "selected_asset_id"   VARCHAR(120),
  "selected_asset_name" TEXT,
  "selected_at"         TIMESTAMPTZ(6),
  "selected_by"         VARCHAR(100),
  "started_at"          TIMESTAMPTZ(6),
  "finished_at"         TIMESTAMPTZ(6),
  "error_msg"           TEXT,
  "requested_by"        VARCHAR(100),
  "version"             INTEGER                 NOT NULL DEFAULT 1,
  "created_at"          TIMESTAMPTZ(6)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"          TIMESTAMPTZ(6)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"          TIMESTAMPTZ(6)
);

CREATE INDEX "search_jobs_status_updated_idx"
  ON "search_jobs" ("status", "updated_at");

CREATE INDEX "search_jobs_schedule_date_idx"
  ON "search_jobs" ("schedule_date");

CREATE INDEX "search_jobs_dc_date_idx"
  ON "search_jobs" ("dc_code", "schedule_date");

-- Active-only partial unique: re-search + terminal kayıt yan yana yaşar.
-- AWAITING_SELECTION da "aktif" sayılır (operatör seçim bekleniyor; başka
-- arama açılması anlamsız).
CREATE UNIQUE INDEX "search_jobs_active_unique"
  ON "search_jobs" ("dc_code", "schedule_date")
  WHERE "status" IN ('QUEUED','RUNNING','AWAITING_SELECTION') AND "deleted_at" IS NULL;

-- ============================================================================
-- Kademe 2: restore_jobs — asset bilgisi + search referans kolonları
-- ============================================================================

ALTER TABLE "restore_jobs"
  ADD COLUMN "search_job_id"   INTEGER;

ALTER TABLE "restore_jobs"
  ADD COLUMN "avid_asset_id"   VARCHAR(120);

ALTER TABLE "restore_jobs"
  ADD COLUMN "avid_asset_name" TEXT;

-- ============================================================================
-- Kademe 3: transfer_jobs — asset bilgisi (restore'dan kopya)
-- ============================================================================

ALTER TABLE "transfer_jobs"
  ADD COLUMN "avid_asset_id"   VARCHAR(120);

ALTER TABLE "transfer_jobs"
  ADD COLUMN "avid_asset_name" TEXT;
