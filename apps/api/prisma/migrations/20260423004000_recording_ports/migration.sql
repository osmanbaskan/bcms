ALTER TABLE "ingest_plan_items"
  ADD COLUMN "planned_start_minute" INTEGER,
  ADD COLUMN "planned_end_minute" INTEGER;

CREATE TABLE "recording_ports" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(50) NOT NULL UNIQUE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "recording_ports_active_sort_order_idx"
  ON "recording_ports"("active", "sort_order");

INSERT INTO "recording_ports" ("name", "sort_order", "active")
VALUES
  ('REC 1', 10, true),
  ('REC 2', 20, true),
  ('REC 3', 30, true),
  ('REC 4', 40, true),
  ('REC 5', 50, true),
  ('REC 6', 60, true),
  ('REC 7', 70, true),
  ('REC 8', 80, true)
ON CONFLICT ("name") DO NOTHING;
