-- Phase A5 (ops/DECISION-BACKEND-CANONICAL-DATA-MODEL-V1.md §4.A5, 2026-05-10)
-- IngestPlanItem.sourceType canonical literal set (DB CHECK + Zod enum + shared
-- literal union). Mevcut 4 distinct değer (live-plan, studio-plan, ingest-plan,
-- manual) kebab-case wire format'ını koruyor.
--
-- Native Prisma enum bilinçli olarak KULLANILMADI:
--   - Prisma enum identifier'ları kebab-case `live-plan` desteklemez (UPPER_SNAKE
--     gerektirir); enum'a geçiş wire format'ı `live-plan` → `LIVE_PLAN` yapardı.
--   - Bu hem mevcut 70 satırın UPDATE'ini hem de frontend literal'lerin
--     değişmesini gerektirirdi (apps/web modify).
--   - Karar: kebab-case korunsun; tip safety Zod enum + shared literal union ile
--     sağlansın; DB seviyesinde CHECK constraint canonical set'i zorlasın.
--
-- Frontend etkisi: YOK (apps/web altında hiçbir dosya değişmedi).
-- Build-phase precheck: 4 distinct değer, 0 invalid satır.

ALTER TABLE "ingest_plan_items"
  ADD CONSTRAINT "ingest_plan_items_source_type_check"
  CHECK ("source_type" IN ('live-plan', 'studio-plan', 'ingest-plan', 'manual'));
