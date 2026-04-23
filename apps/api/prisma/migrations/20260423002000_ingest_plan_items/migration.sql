CREATE TYPE "ingest_plan_status" AS ENUM (
  'WAITING',
  'RECEIVED',
  'INGEST_STARTED',
  'COMPLETED',
  'ISSUE'
);

CREATE TABLE "ingest_plan_items" (
  "id" SERIAL PRIMARY KEY,
  "source_type" VARCHAR(30) NOT NULL,
  "source_key" VARCHAR(500) NOT NULL UNIQUE,
  "day_date" DATE NOT NULL,
  "source_path" TEXT,
  "status" "ingest_plan_status" NOT NULL DEFAULT 'WAITING',
  "job_id" INTEGER,
  "note" TEXT,
  "updated_by" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ingest_plan_items_day_date_idx" ON "ingest_plan_items"("day_date");
CREATE INDEX "ingest_plan_items_status_idx" ON "ingest_plan_items"("status");
