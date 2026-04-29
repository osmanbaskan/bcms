CREATE TABLE IF NOT EXISTS "shift_assignments" (
  "id" SERIAL PRIMARY KEY,
  "user_id" VARCHAR(100) NOT NULL,
  "user_name" VARCHAR(100) NOT NULL,
  "user_group" VARCHAR(50) NOT NULL,
  "week_start" VARCHAR(10) NOT NULL,
  "day_index" INTEGER NOT NULL,
  "start_time" VARCHAR(5),
  "end_time" VARCHAR(5),
  "type" VARCHAR(20) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "shift_assignments_user_id_week_start_day_index_key"
  ON "shift_assignments"("user_id", "week_start", "day_index");

CREATE INDEX IF NOT EXISTS "idx_shift_week_group"
  ON "shift_assignments"("week_start", "user_group");

CREATE INDEX IF NOT EXISTS "idx_shift_user_week"
  ON "shift_assignments"("user_id", "week_start");
