-- Phase A3 (ops/DECISION-BACKEND-CANONICAL-DATA-MODEL-V1.md §4.A3, 2026-05-09)
-- IngestJob.version optimistic locking — terminal status race koruması
-- (worker + callback authoritative üreticiler). Internal guard; external
-- callback contract DEĞİŞMEZ (If-Match opsiyonel/yok).
--
-- NOT NULL DEFAULT 1: mevcut row'lar default ile otomatik backfill;
-- ek UPDATE gerekmez. Service `updateMany` + status filter + version
-- increment ile race idempotent.

ALTER TABLE "ingest_jobs"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
