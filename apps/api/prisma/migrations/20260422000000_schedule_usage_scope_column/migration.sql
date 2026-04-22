-- Store the live-plan/reporting-ingest usage rule in a first-class column.
ALTER TABLE "schedules"
ADD COLUMN IF NOT EXISTS "usage_scope" VARCHAR(30) NOT NULL DEFAULT 'broadcast';

UPDATE "schedules"
SET "usage_scope" = 'live-plan'
WHERE "metadata" ->> 'usageScope' = 'reporting-ingest'
   OR "metadata" ->> 'source' = 'live-plan';

CREATE INDEX IF NOT EXISTS "schedules_usage_scope_idx" ON "schedules"("usage_scope");
