-- Provys İçerik Kontrol (2026-05-22): current-snapshot store for parsed BXF
-- entries. Worker writes; API reads + SSE streams via pg_notify('provys_changed').

CREATE TABLE "provys_items" (
  "id"            SERIAL PRIMARY KEY,
  "channel_slug"  VARCHAR(40)   NOT NULL,
  "event_id"      VARCHAR(120)  NOT NULL,
  "sequence"      INTEGER       NOT NULL DEFAULT 0,
  "start_at"      TIMESTAMPTZ(6) NOT NULL,
  "duration_ms"   INTEGER,
  "title"         VARCHAR(500)  NOT NULL,
  "raw_kind"      VARCHAR(100),
  "category"      VARCHAR(20)   NOT NULL,
  "source_file"   VARCHAR(500)  NOT NULL,
  "source_mtime"  TIMESTAMPTZ(6) NOT NULL,
  "payload_hash"  VARCHAR(64)   NOT NULL,
  "created_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX "provys_items_channel_event_unique"
  ON "provys_items" ("channel_slug", "event_id");

CREATE INDEX "provys_items_channel_seq_idx"
  ON "provys_items" ("channel_slug", "sequence");
