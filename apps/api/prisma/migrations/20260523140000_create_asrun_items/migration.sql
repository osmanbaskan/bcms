-- Asrun — playout sonrası gerçekleşen yayın kaydı (as-run log).
-- Provys playlist tablosundan tamamen ayrı; asrun-watcher kendi SMB
-- kaynağından ingest eder. Composed merge YOK — eventId-bazlı upsert.
CREATE TABLE IF NOT EXISTS "asrun_items" (
  "id"                SERIAL PRIMARY KEY,
  "channel_slug"      VARCHAR(40)              NOT NULL,
  "schedule_date"     DATE                     NOT NULL,
  "event_id"          VARCHAR(120)             NOT NULL,
  "sequence"          INTEGER                  NOT NULL DEFAULT 0,
  "start_at"          TIMESTAMPTZ(6)           NOT NULL,
  "duration_ms"       INTEGER,
  "start_timecode"    VARCHAR(20),
  "duration_timecode" VARCHAR(20),
  "frame_rate"        INTEGER,
  "dc_code"           VARCHAR(40),
  "title"             VARCHAR(500)             NOT NULL,
  "raw_kind"          VARCHAR(100),
  "category"          VARCHAR(20)              NOT NULL,
  "source_file"       VARCHAR(500)             NOT NULL,
  "source_mtime"      TIMESTAMPTZ(6)           NOT NULL,
  "payload_hash"      VARCHAR(64)              NOT NULL,
  "created_at"        TIMESTAMPTZ(6)           NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ(6)           NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "asrun_items_channel_date_event_unique"
  ON "asrun_items" ("channel_slug", "schedule_date", "event_id");
CREATE INDEX IF NOT EXISTS "asrun_items_channel_date_start_idx"
  ON "asrun_items" ("channel_slug", "schedule_date", "start_at");
