-- Restore + Transfer V2 — Avid Interplay iki kademeli iş akışı (audit doc).
--
-- Kademe 1 (restore_jobs): Avid arşivinden Interplay workspace'e asset getirme.
-- Kademe 2 (transfer_jobs): Online asset'i Avid'den production storage'a aktarma.
--
-- İki ayrı tablo, ayrı state machine, ayrı lifecycle.
-- transfer_jobs.restore_job_id bilgi alanı (FK YOK — lifecycle bağımsız;
-- audit retention purge cascade riski yaratır; service guard precondition'ı yeterli).
--
-- Idempotency (her iki tabloda): aynı (dc_code, schedule_date) için aynı anda
-- yalnız 1 aktif (QUEUED/RUNNING) job. Partial unique index DB seviyesinde
-- garanti eder. Prisma 5 partial @@unique sınırlı destekli — schema.prisma
-- içinde @@unique YAZILMAZ; UNIQUE bu migration SQL'de tutulur (outbox
-- idempotency_key pattern paritesi).

-- ============================================================================
-- Kademe 1: restore_jobs
-- ============================================================================

CREATE TYPE "restore_job_status" AS ENUM (
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "restore_jobs" (
  "id"             SERIAL                  PRIMARY KEY,
  "dc_code"        VARCHAR(40)             NOT NULL,
  "channel_slug"   VARCHAR(30)             NOT NULL,
  "schedule_date"  DATE                    NOT NULL,
  "status"         "restore_job_status"    NOT NULL DEFAULT 'QUEUED',
  "attempt_count"  INTEGER                 NOT NULL DEFAULT 0,
  "max_attempts"   INTEGER                 NOT NULL DEFAULT 3,
  "avid_job_id"    VARCHAR(80),
  "started_at"     TIMESTAMPTZ(6),
  "finished_at"    TIMESTAMPTZ(6),
  "error_msg"      TEXT,
  "requested_by"   VARCHAR(100),
  "version"        INTEGER                 NOT NULL DEFAULT 1,
  "created_at"     TIMESTAMPTZ(6)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMPTZ(6)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"     TIMESTAMPTZ(6)
);

CREATE INDEX "restore_jobs_status_updated_idx"
  ON "restore_jobs" ("status", "updated_at");

CREATE INDEX "restore_jobs_schedule_date_idx"
  ON "restore_jobs" ("schedule_date");

CREATE INDEX "restore_jobs_dc_date_idx"
  ON "restore_jobs" ("dc_code", "schedule_date");

-- Active-only partial unique: re-restore + historik FAILED kayıt yan yana
-- yaşar. Aynı dc_code+schedule_date için sadece 1 aktif (QUEUED/RUNNING) job
-- garantilenir; terminal kayıtlar (DONE/FAILED/CANCELLED) ve soft-delete
-- (deleted_at NOT NULL) constraint dışında.
CREATE UNIQUE INDEX "restore_jobs_active_unique"
  ON "restore_jobs" ("dc_code", "schedule_date")
  WHERE "status" IN ('QUEUED', 'RUNNING') AND "deleted_at" IS NULL;

-- ============================================================================
-- Kademe 2: transfer_jobs
-- ============================================================================

CREATE TYPE "transfer_job_status" AS ENUM (
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
  'CANCELLED'
);

CREATE TABLE "transfer_jobs" (
  "id"              SERIAL                   PRIMARY KEY,
  "dc_code"         VARCHAR(40)              NOT NULL,
  "channel_slug"    VARCHAR(30)              NOT NULL,
  "schedule_date"   DATE                     NOT NULL,
  "restore_job_id"  INTEGER,                 -- bilgi amaçlı; FK YOK (lifecycle bağımsız)
  "status"          "transfer_job_status"    NOT NULL DEFAULT 'QUEUED',
  "attempt_count"   INTEGER                  NOT NULL DEFAULT 0,
  "max_attempts"    INTEGER                  NOT NULL DEFAULT 3,
  "avid_job_id"     VARCHAR(80),
  "started_at"      TIMESTAMPTZ(6),
  "finished_at"     TIMESTAMPTZ(6),
  "error_msg"       TEXT,
  "requested_by"    VARCHAR(100),
  "version"         INTEGER                  NOT NULL DEFAULT 1,
  "created_at"      TIMESTAMPTZ(6)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMPTZ(6)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"      TIMESTAMPTZ(6)
);

CREATE INDEX "transfer_jobs_status_updated_idx"
  ON "transfer_jobs" ("status", "updated_at");

CREATE INDEX "transfer_jobs_schedule_date_idx"
  ON "transfer_jobs" ("schedule_date");

CREATE INDEX "transfer_jobs_dc_date_idx"
  ON "transfer_jobs" ("dc_code", "schedule_date");

CREATE UNIQUE INDEX "transfer_jobs_active_unique"
  ON "transfer_jobs" ("dc_code", "schedule_date")
  WHERE "status" IN ('QUEUED', 'RUNNING') AND "deleted_at" IS NULL;
