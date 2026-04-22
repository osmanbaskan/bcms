-- Promote live-plan reporting dimensions out of JSON metadata so reports can
-- use typed, indexable columns instead of JSON path scans.
ALTER TABLE "schedules"
ADD COLUMN IF NOT EXISTS "report_league" VARCHAR(200),
ADD COLUMN IF NOT EXISTS "report_season" VARCHAR(30),
ADD COLUMN IF NOT EXISTS "report_week_number" INTEGER;

UPDATE "schedules"
SET
  "report_league" = NULLIF(BTRIM("metadata" ->> 'league'), ''),
  "report_season" = NULLIF(BTRIM("metadata" ->> 'season'), ''),
  "report_week_number" = CASE
    WHEN ("metadata" ->> 'weekNumber') ~ '^[0-9]+$'
    THEN ("metadata" ->> 'weekNumber')::INTEGER
    ELSE NULL
  END
WHERE "usage_scope" = 'live-plan'
  AND "metadata" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "schedules_usage_report_dims_idx"
ON "schedules"("usage_scope", "report_league", "report_season", "report_week_number");
