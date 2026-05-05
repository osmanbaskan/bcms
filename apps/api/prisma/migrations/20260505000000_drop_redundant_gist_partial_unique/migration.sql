-- HIGH-INF-019 + HIGH-INF-020 fix (2026-05-05)
-- 1) Schedule üzerindeki redundant GiST exclusion'u kaldır.
--    schedules_no_overlap (eski, [] semantic) ile schedules_no_channel_time_overlap
--    ([)  semantic — end-exclusive, daha doğru) örtüşüyor; sadece doğru olan
--    kalır.
-- 2) Soft-delete olan tablolarda unique alanları partial index'e çevir
--    (WHERE deleted_at IS NULL); böylece silinen + yeni oluşturulan kayıt
--    çakışmaz.

-- ── 1. Redundant GiST exclusion drop ────────────────────────────────────────
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_no_overlap;

-- ── 2. Partial unique indexes (soft-delete uyumlu) ──────────────────────────

-- Channel.name
DROP INDEX IF EXISTS channels_name_key;
CREATE UNIQUE INDEX channels_name_key ON channels (name) WHERE deleted_at IS NULL;

-- League.code
DROP INDEX IF EXISTS leagues_code_key;
CREATE UNIQUE INDEX leagues_code_key ON leagues (code) WHERE deleted_at IS NULL;

-- StudioPlanProgram.name
DROP INDEX IF EXISTS studio_plan_programs_name_key;
CREATE UNIQUE INDEX studio_plan_programs_name_key ON studio_plan_programs (name) WHERE deleted_at IS NULL;

-- RecordingPort.name
DROP INDEX IF EXISTS recording_ports_name_key;
CREATE UNIQUE INDEX recording_ports_name_key ON recording_ports (name) WHERE deleted_at IS NULL;

-- IngestPlanItem.sourceKey (varsa)
DROP INDEX IF EXISTS ingest_plan_items_source_key_key;
CREATE UNIQUE INDEX ingest_plan_items_source_key_key ON ingest_plan_items (source_key) WHERE deleted_at IS NULL AND source_key IS NOT NULL;

-- ShiftAssignment composite unique (HIGH-INF-020)
-- Mevcut: UNIQUE(user_id, week_start, day_index) – soft-delete olan tabloda
-- yeniden atama çakışıyor.
DROP INDEX IF EXISTS shift_assignments_user_id_week_start_day_index_key;
CREATE UNIQUE INDEX shift_assignments_user_id_week_start_day_index_key
  ON shift_assignments (user_id, week_start, day_index) WHERE deleted_at IS NULL;
