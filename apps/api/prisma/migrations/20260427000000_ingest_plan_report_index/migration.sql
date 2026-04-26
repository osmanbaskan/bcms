-- Ingest plan rapor sorgusu için composite index
-- WHERE day_date BETWEEN from AND to ORDER BY day_date, planned_start_minute, source_key
CREATE INDEX IF NOT EXISTS ingest_plan_items_report_idx
  ON ingest_plan_items (day_date, planned_start_minute, source_key);
