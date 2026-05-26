-- SSDB MAM materyal lookup cache (DC-bazli; kanal/gun-bagimsiz).
-- Provys watcher hash/diff mantigini bozmamak icin tamamen ayri tablo.
-- ProvysItem tablosuna DOKUNULMAZ. Cache satirinda sadece SSDB raw fact
-- saklanir; Provys row x cache karsilastirma sonucu (found_match,
-- mismatch vb.) response-time hesaplanir, buraya YAZILMAZ.
CREATE TABLE "ssdb_material_cache" (
  "dc_code"                 VARCHAR(40)              NOT NULL,
  "lookup_status"           VARCHAR(32)              NOT NULL,
  "media_guid"              VARCHAR(36),
  "media_name"              VARCHAR(500),
  "media_alias"             VARCHAR(500),
  "original_filename"       VARCHAR(500),
  "match_method"            VARCHAR(40),
  "tc_som"                  INTEGER,
  "tc_eom"                  INTEGER,
  "ssdb_duration_frames"    INTEGER,
  "ssdb_duration_timecode"  VARCHAR(20),
  "frame_rate"              INTEGER,
  "last_checked_at"         TIMESTAMPTZ(6)           NOT NULL,
  "last_found_at"           TIMESTAMPTZ(6),
  "last_error"              VARCHAR(500),
  "created_at"              TIMESTAMPTZ(6)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"              TIMESTAMPTZ(6)           NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ssdb_material_cache_pkey" PRIMARY KEY ("dc_code")
);

-- Worker tick TTL filter index: status + last_checked_at uzerinden
-- "TTL dolan adaylari sec" sorgusu bu indexi kullanir.
CREATE INDEX "ssdb_cache_lookup_checked_idx"
  ON "ssdb_material_cache" ("lookup_status", "last_checked_at");
