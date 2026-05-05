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

-- ── 3. HIGH-INF-010: kullanılmayan modelleri drop ──────────────────────────
-- content_entry_categories: 0 row, hiçbir FK yok
-- content_entry_tags: 0 row, hiçbir FK yok
-- workspaces: 1 seed row "Ana Workspace", hiçbir FK yok, kod tabanında da
--             referans bulunamadı.
DROP TABLE IF EXISTS content_entry_categories;
DROP TABLE IF EXISTS content_entry_tags;
DROP TABLE IF EXISTS workspaces;

-- ── 4. HIGH-INF-011: deleted_at partial index (soft-delete query optimize) ─
-- WHERE deleted_at IS NULL filter çoğu listing'de var; sequential scan
-- yerine btree partial index ile O(log n) filter.
CREATE INDEX IF NOT EXISTS audit_logs_deleted_at_idx ON audit_logs (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS bookings_deleted_at_idx ON bookings (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS broadcast_types_deleted_at_idx ON broadcast_types (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS channels_deleted_at_idx ON channels (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS incidents_deleted_at_idx ON incidents (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingest_jobs_deleted_at_idx ON ingest_jobs (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS ingest_plan_items_deleted_at_idx ON ingest_plan_items (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS leagues_deleted_at_idx ON leagues (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS matches_deleted_at_idx ON matches (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS qc_reports_deleted_at_idx ON qc_reports (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS recording_ports_deleted_at_idx ON recording_ports (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS schedules_deleted_at_idx ON schedules (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS shift_assignments_deleted_at_idx ON shift_assignments (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS signal_telemetry_deleted_at_idx ON signal_telemetry (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_plan_colors_deleted_at_idx ON studio_plan_colors (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_plan_programs_deleted_at_idx ON studio_plan_programs (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_plan_slots_deleted_at_idx ON studio_plan_slots (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS studio_plans_deleted_at_idx ON studio_plans (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS teams_deleted_at_idx ON teams (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS timeline_events_deleted_at_idx ON timeline_events (deleted_at) WHERE deleted_at IS NOT NULL;
