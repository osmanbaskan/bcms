-- Madde 5 M5-B1 (audit doc): live_plan_entries foundation — schema only.
--
-- Tasarım: ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md §3.2 (M5-B1 Scope Lock)
-- Locked decisions (K1..K6, 2026-05-06):
--   K1: matchId + optaMatchId nullable; opta_match_id unique DEĞİL
--   K2: LivePlanStatus = PLANNED/READY/IN_PROGRESS/COMPLETED/CANCELLED (manuel)
--   K3: version optimistic locking (M5-B2 If-Match implementation)
--   K4: audit subject "LivePlanEntry" (M5-B2 service writes)
--   K5: canonical /api/v1/live-plan (M5-B2 implementation; shim YOK)
--   K6: schema foundation only; createdBy nullable
--
-- M5-B1 KAPSAM (sadece foundation):
--   - live_plan_entries tablo
--   - LivePlanStatus enum
--   - 4 index (status+event_start_time; event_start_time; match_id; opta_match_id)
--   - matchId FK -> matches(id) ON DELETE SET NULL
--
-- M5-B1 KAPSAM DIŞI: service/route, UI, ingest_plan_items FK, cleanup, outbox shadow.

-- ── Enum ──────────────────────────────────────────────────────────────────────
CREATE TYPE "LivePlanStatus" AS ENUM (
    'PLANNED',
    'READY',
    'IN_PROGRESS',
    'COMPLETED',
    'CANCELLED'
);

-- ── Tablo ─────────────────────────────────────────────────────────────────────
CREATE TABLE "live_plan_entries" (
    "id"                SERIAL PRIMARY KEY,
    "title"             VARCHAR(500)   NOT NULL,
    "event_start_time"  TIMESTAMPTZ(6) NOT NULL,
    "event_end_time"    TIMESTAMPTZ(6) NOT NULL,
    "match_id"          INTEGER,
    "opta_match_id"     VARCHAR(80),
    "status"            "LivePlanStatus" NOT NULL DEFAULT 'PLANNED',
    "operation_notes"   TEXT,
    "metadata"          JSONB,
    "created_by"        VARCHAR(100),
    "version"           INTEGER        NOT NULL DEFAULT 1,
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at"        TIMESTAMPTZ(6)
);

-- ── FK: match_id -> matches.id, ON DELETE SET NULL (K1 locked) ───────────────
ALTER TABLE "live_plan_entries"
    ADD CONSTRAINT "live_plan_entries_match_id_fkey"
    FOREIGN KEY ("match_id") REFERENCES "matches"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Index seti (4 adet — DECISION §3.2) ───────────────────────────────────────
-- List/filter hot-path: status + zaman sırası
CREATE INDEX "live_plan_entries_status_event_start_idx"
    ON "live_plan_entries"("status", "event_start_time");

-- Date range query (haftalık/günlük view)
CREATE INDEX "live_plan_entries_event_start_idx"
    ON "live_plan_entries"("event_start_time");

-- Match relation lookup
CREATE INDEX "live_plan_entries_match_idx"
    ON "live_plan_entries"("match_id");

-- External OPTA dedup/lookup (K1 locked: unique DEĞİL — aynı OPTA event'ten
-- birden fazla operasyon planı mümkün)
CREATE INDEX "live_plan_entries_opta_match_idx"
    ON "live_plan_entries"("opta_match_id");

-- NOT: deleted_at index DEFERRED (audit 3.2.4 soft-delete barely-used; erken
-- optimize etme — soft-delete query pattern netleşince eklenir).
