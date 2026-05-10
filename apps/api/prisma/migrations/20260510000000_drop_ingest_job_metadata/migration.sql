-- Phase A4 (ops/DECISION-BACKEND-CANONICAL-DATA-MODEL-V1.md §4.A4, 2026-05-10)
-- IngestJob.metadata kolon DROP. A2 PR-2c (metadata.ingestPlanSourceKey resolver
-- removal) production-role'de yerleşik; service-layer artık metadata yazmıyor.
--
-- Build-phase notu (2026-05-10): proje hâlâ inşa aşamasında; ingest_jobs
-- içindeki veriler operasyonel olarak önemsiz. PR-2b production-role
-- post-validation null_fk_matchable=0 + metadata_only_after_pr2a=0 ile
-- gözlem süresi atlandı.
--
-- Veri kaybı kalıcı: kolon DROP geri alınamaz. Reverse migration ile kolon
-- yeniden ADD edilse bile eski JSON içerikler dönmez. Rollback yalnız
-- snapshot/backup'tan tablo restore yoluyla yapılır.
--
-- Frontend: bu PR apps/web altında değişiklik içermez. ingest-list ekranında
-- `j.metadata?.['scheduleTitle']` referansı runtime'da `undefined` döner ve
-- `'#' + j.targetId` fallback'i devreye girer (mevcut template). Frontend
-- cleanup ayrı follow-up PR'da yapılacak.

ALTER TABLE "ingest_jobs"
  DROP COLUMN "metadata";
