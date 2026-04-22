-- The canonical live-plan marker is schedules.usage_scope. Remove the old
-- transition-only metadata.usageScope flag so future code does not rely on it.
UPDATE "schedules"
SET "metadata" = "metadata" - 'usageScope'
WHERE "metadata" ? 'usageScope';
