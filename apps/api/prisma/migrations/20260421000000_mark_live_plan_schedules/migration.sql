-- Existing records created from the live broadcast plan UI were stored as
-- generic schedules. Mark rows that carry live-plan metadata so reporting and
-- ingest can target them without leaking them into generic schedule consumers.
UPDATE "schedules"
SET "metadata" = COALESCE("metadata", '{}'::jsonb) || '{"source":"live-plan","usageScope":"reporting-ingest"}'::jsonb
WHERE "created_by" <> 'bxf-importer'
  AND COALESCE("metadata", '{}'::jsonb) <> '{}'::jsonb
  AND (
    "metadata" ? 'contentName'
    OR "metadata" ? 'transStart'
    OR "metadata" ? 'transEnd'
    OR "metadata" ? 'houseNumber'
    OR "metadata" ? 'liveDetails'
  );
