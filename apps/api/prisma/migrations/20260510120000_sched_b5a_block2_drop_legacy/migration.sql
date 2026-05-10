-- SCHED-B5a Block 2 destructive cleanup (2026-05-10)
--
-- Scope (ops/REQUIREMENTS-SCHEDULE-CLEANUP-V1.md Y5-2a; iki revize sonrası
-- locked):
--   - usage_scope kod dependency sıfır (B5a Block 1 done) → CHECK + 2 index
--     + kolon DROP.
--   - schedules.deleted_at hard-delete domain → soft-delete kalıntısı
--     temizlendi; Prisma field + kolon + partial index DROP.
--   - schedules_no_channel_time_overlap GiST exclusion DROP (legacy single-
--     channel constraint; canonical broadcast flow 3-channel slot modeline
--     uymuyordu; Y5-5 yeni cross-row overlap constraint AYRI PR).
--   - Legacy 132 satır DELETE (event_key IS NULL filter; broadcast flow
--     row guarantee'siz). FK cascade impact 0 (timeline_events / bookings /
--     incidents NOT NULL count = 0).
--
-- Out of scope (Y5-8 / B5b / Y5-7 follow-up):
--   - schedules.channel_id kolon + schedules_channel_id_fkey + Schedule.
--     channel relation: Playout/MCR backend coupling nedeniyle ertelendi
--     (`apps/api/src/modules/playout/playout.routes.ts` aktif kullanım).
--   - schedules.metadata + schedules.start_time + schedules.end_time:
--     reporting `/schedules/reporting` aktif bağımlı (B5b reporting
--     canonicalization sonrası DROP).
--   - LivePlanEntry / scheduleCommercialOption / scheduleLogoOption /
--     scheduleFormatOption soft-delete pattern'i: ayrı domain master data,
--     korundu.

-- ── 1. Legacy schedule satırları DELETE ─────────────────────────────────
-- 132 satır beklenir (event_key IS NULL = broadcast flow row guarantee'siz).
-- Cascade FK 0 (timeline_events.schedule_id, bookings.schedule_id,
-- incidents.schedule_id 0 row).
DELETE FROM schedules WHERE event_key IS NULL;

-- ── 2. Legacy GiST exclusion DROP ───────────────────────────────────────
-- channel_id + start_time + end_time tabanlı; canonical 3-channel slot
-- modeline uymuyor. Yeni cross-row overlap constraint Y5-5 ayrı PR.
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_no_channel_time_overlap;

-- ── 3. usage_scope CHECK ────────────────────────────────────────────────
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_usage_scope_check;

-- ── 4. usage_scope indexes ──────────────────────────────────────────────
DROP INDEX IF EXISTS schedules_usage_scope_idx;
DROP INDEX IF EXISTS schedules_usage_scope_report_league_report_season_report_we_idx;

-- ── 5. deleted_at partial index (hard-delete domain) ────────────────────
DROP INDEX IF EXISTS schedules_deleted_at_idx;

-- ── 6. Kolon DROP ───────────────────────────────────────────────────────
-- usage_scope: kod dependency sıfır (Block 1).
-- deleted_at: Schedule entity'sinde soft-delete kullanılmıyor; canonical
--             broadcast flow hard-delete (schedule.service.removeBroadcastFlow
--             tx.schedule.delete).
ALTER TABLE schedules
  DROP COLUMN IF EXISTS usage_scope,
  DROP COLUMN IF EXISTS deleted_at;
