CREATE TABLE "studio_plans" (
  "id" SERIAL PRIMARY KEY,
  "week_start" DATE NOT NULL UNIQUE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by" VARCHAR(100) NOT NULL,
  "updated_by" VARCHAR(100),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "studio_plan_slots" (
  "id" SERIAL PRIMARY KEY,
  "plan_id" INTEGER NOT NULL,
  "day_date" DATE NOT NULL,
  "studio" VARCHAR(100) NOT NULL,
  "start_minute" INTEGER NOT NULL,
  "program" VARCHAR(300) NOT NULL,
  "color" VARCHAR(20) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "studio_plan_slots_plan_id_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "studio_plans"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "studio_plan_slots_plan_id_day_date_studio_start_minute_key"
  ON "studio_plan_slots"("plan_id", "day_date", "studio", "start_minute");

CREATE INDEX "studio_plan_slots_day_date_studio_idx"
  ON "studio_plan_slots"("day_date", "studio");
