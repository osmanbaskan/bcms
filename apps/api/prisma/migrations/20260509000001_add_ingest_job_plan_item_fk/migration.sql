-- Phase A2 PR-2a (ops/DECISION-BACKEND-CANONICAL-DATA-MODEL-V1.md §4.A2, 2026-05-09)
-- IngestJob.planItemId structured FK; transient `metadata.ingestPlanSourceKey`
-- yerine canonical kaynak. Bu migration sadece schema değişikliğini içerir;
-- backfill UPDATE ayrı gate (PR-2b) — DECISION V1 §10/4 ("ADD COLUMN +
-- UPDATE + (gerekirse) DROP — aynı PR'da değil; data güvenlik").
--
--   1. ADD COLUMN plan_item_id (NULLable; mevcut row'lar etkilenmez —
--      orphan pre-clean gereksiz).
--   2. INDEX ingest_jobs_plan_item_id_idx.
--   3. ADD CONSTRAINT FK ON DELETE SET NULL (DECISION V1 §2/6 — operasyonel
--      domain'de cascade DELETE rapor sızıntısı yaratır; plan item silindiğinde
--      IngestJob historik kaydı korunur, plan_item_id NULL'lanır).
--
-- Mevcut `ingest_plan_items.job_id` FK constraint (ON DELETE CASCADE) DOKUNULMAZ;
-- bu tersi yöndeki ilişki (job silindiğinde plan satırının silinmesi —
-- mevcut karar; A2'de değişmiyor).

-- 1. ADD COLUMN
ALTER TABLE "ingest_jobs"
  ADD COLUMN "plan_item_id" INTEGER NULL;

-- 2. INDEX
CREATE INDEX "ingest_jobs_plan_item_id_idx" ON "ingest_jobs"("plan_item_id");

-- 3. FK constraint
ALTER TABLE "ingest_jobs"
  ADD CONSTRAINT "ingest_jobs_plan_item_id_fkey"
  FOREIGN KEY ("plan_item_id")
  REFERENCES "ingest_plan_items"("id")
  ON DELETE SET NULL
  ON UPDATE NO ACTION;
