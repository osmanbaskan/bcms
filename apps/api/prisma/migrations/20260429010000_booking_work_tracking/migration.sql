ALTER TABLE "bookings" ALTER COLUMN "schedule_id" DROP NOT NULL;

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "task_title" VARCHAR(300),
  ADD COLUMN IF NOT EXISTS "task_details" TEXT,
  ADD COLUMN IF NOT EXISTS "task_report" TEXT,
  ADD COLUMN IF NOT EXISTS "user_group" VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "assignee_id" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "assignee_name" VARCHAR(200),
  ADD COLUMN IF NOT EXISTS "start_date" DATE,
  ADD COLUMN IF NOT EXISTS "due_date" DATE,
  ADD COLUMN IF NOT EXISTS "completed_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "bookings_user_group_idx" ON "bookings"("user_group");
CREATE INDEX IF NOT EXISTS "bookings_assignee_id_idx" ON "bookings"("assignee_id");
CREATE INDEX IF NOT EXISTS "bookings_start_date_due_date_idx" ON "bookings"("start_date", "due_date");
