ALTER TABLE "schedules"
DROP CONSTRAINT IF EXISTS "schedules_usage_scope_check";

ALTER TABLE "schedules"
ADD CONSTRAINT "schedules_usage_scope_check"
CHECK ("usage_scope" IN ('broadcast', 'live-plan'));
