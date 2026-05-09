-- Phase A1 (ops/DECISION-BACKEND-CANONICAL-DATA-MODEL-V1.md §4.A1, 2026-05-09)
-- IngestJob.targetId canonical olarak live_plan_entries.id'ye işaret eder
-- (Y5-7 lock: ingest schedule coupling kaldırıldı). Bu migration:
--   1. Orphan target_id değerlerini NULL'a çeker (FK ekleme öncesi pre-clean).
--   2. ingest_jobs.target_id → live_plan_entries(id) FK ekler.
--   3. ON DELETE SET NULL: entry hard-delete sonrası IngestJob historic
--      kaydı korunur, target_id NULL'lanır.
-- Mevcut @@index([targetId]) indexi (ix_ingest_jobs_target_id veya
-- otomatik isim) korunur; ek index oluşturulmaz.

-- 1. Orphan pre-clean — FK eklemeden önce referans bütünlüğünü garanti et.
UPDATE ingest_jobs
   SET target_id = NULL
 WHERE target_id IS NOT NULL
   AND target_id NOT IN (SELECT id FROM live_plan_entries);

-- 2. FK constraint
ALTER TABLE "ingest_jobs"
  ADD CONSTRAINT "ingest_jobs_target_id_fkey"
  FOREIGN KEY ("target_id")
  REFERENCES "live_plan_entries"("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;
