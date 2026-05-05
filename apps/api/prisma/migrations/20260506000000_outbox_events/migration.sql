-- Madde 2+7 PR-A (audit doc): Outbox + DLQ V1 — schema foundation only.
--
-- Tasarım: ops/REQUIREMENTS-OUTBOX-DLQ-V1.md
-- Locked decisions:
--   - Polling 2sn, MAX_ATTEMPTS=5, backoff cap 30 dk (PR-A scope dışı; sadece schema)
--   - Phase 2 shadow status='published'; Phase 3 cut-over (PR-A scope dışı)
--   - Idempotency: eventId UUID v4 (consumer dedup PR-C audit)
--   - Ordering yok V1; published outbox 30 gün retention (PR-D defer)
--
-- PR-A KAPSAM (sadece foundation):
--   - outbox_events tablo
--   - 3 index (status+next_attempt poller hot-path; aggregate lookup; event_type)
--   - CHECK status enum (Madde 4 pattern; Prisma 5 native CHECK desteklemiyor)
--
-- PR-A KAPSAM DIŞI: poller, service refactor, admin endpoint, metric, feature flag.

CREATE TABLE "outbox_events" (
    "id"              SERIAL PRIMARY KEY,
    -- UUID v4; idempotency anchor; consumer dedup key. crypto.randomUUID() = 36 char.
    "event_id"        VARCHAR(36) NOT NULL UNIQUE,
    "event_type"      VARCHAR(100) NOT NULL,
    "aggregate_type"  VARCHAR(50)  NOT NULL,
    "aggregate_id"    VARCHAR(50)  NOT NULL,
    "schema_version"  INTEGER      NOT NULL DEFAULT 1,
    -- Object convention (envelope helper); DB enforces JSONB only.
    "payload"         JSONB        NOT NULL,
    -- pending | published | failed | dead (CHECK constraint aşağıda).
    "status"          VARCHAR(20)  NOT NULL DEFAULT 'pending',
    "attempts"        INTEGER      NOT NULL DEFAULT 0,
    "last_error"      TEXT,
    "occurred_at"     TIMESTAMPTZ(6) NOT NULL,
    "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "published_at"    TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- Status enum CHECK constraint (Prisma 5 native CHECK desteklemiyor; manuel migration).
-- Test setup'ta applyOutboxConstraints() ile reapply edilir (db push migration tüketmez).
ALTER TABLE "outbox_events"
    ADD CONSTRAINT "outbox_events_status_check"
    CHECK ("status" IN ('pending','published','failed','dead'));

-- Poller hot-path: pending event'leri next_attempt_at'a göre çek.
CREATE INDEX "outbox_events_status_next_attempt_idx"
    ON "outbox_events"("status", "next_attempt_at");

-- Aggregate lookup: bir entity için tüm event'ler (replay/inspect).
CREATE INDEX "outbox_events_aggregate_idx"
    ON "outbox_events"("aggregate_type", "aggregate_id");

-- Event type filtering (admin endpoint, alerting).
CREATE INDEX "outbox_events_event_type_idx"
    ON "outbox_events"("event_type");
