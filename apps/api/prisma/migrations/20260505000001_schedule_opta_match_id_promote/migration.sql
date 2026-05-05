-- Madde 3 PR-3A (audit doc): metadata.optaMatchId → kolon promote (transition).
--
-- Nullable + non-unique index: aynı OPTA match için birden fazla schedule/live-plan
-- entry mümkün (kullanıcı kararı 2026-05-04). Unique constraint koymuyoruz.
--
-- Backfill guard'ları:
--   - jsonb_typeof(metadata) = 'object' (array/scalar metadata corruption koruması)
--   - metadata ? 'optaMatchId' (key existence)
--   - NULLIF(text, '') IS NOT NULL (boş string'i NULL kabul et)

ALTER TABLE "schedules" ADD COLUMN "opta_match_id" VARCHAR(50);

CREATE INDEX "schedules_opta_match_id_idx" ON "schedules"("opta_match_id");

UPDATE "schedules"
SET "opta_match_id" = metadata->>'optaMatchId'
WHERE jsonb_typeof(metadata) = 'object'
  AND metadata ? 'optaMatchId'
  AND NULLIF(metadata->>'optaMatchId', '') IS NOT NULL;
