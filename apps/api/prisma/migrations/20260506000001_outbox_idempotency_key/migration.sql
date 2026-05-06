-- Madde 2+7 PR-B3b-2 schema PR (audit doc): outbox idempotency_key foundation.
--
-- Karar: ops/DECISION-INGEST_COMPLETED-AUTHORITATIVE-PRODUCER.md sub-option B2.
--
-- Aggregate-level idempotency key, eventId UUID v4'ten ayrı bir kolon olarak
-- tutulur. Tek üreticinin aynı domain event'i iki defa yazması (callback +
-- worker INGEST_COMPLETED race) DB seviyesinde dedup'lanır.
--
-- Partial unique index: NULL kabul eden kolonda DB-level UNIQUE garantisi
-- sadece set edilmiş satırlar için. NULL'lar normal davranır (mevcut domain
-- event'ler — booking, schedule, ingest_started — bu kolonu kullanmaz).
--
-- Prisma 5 partial @@unique desteği sınırlı: schema.prisma'da yalnız nullable
-- field tanımlanır; UNIQUE bu migration SQL'de + test interim helper'da kalır
-- (Madde 4 + PR-A CHECK pattern).

ALTER TABLE "outbox_events"
    ADD COLUMN "idempotency_key" VARCHAR(160);

-- Partial unique index: sadece set edilmiş satırlar UNIQUE.
-- INSERT sırasında ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL
-- DO NOTHING semantik kullanılır; conflict_target predicate aynı şekilde verilmeli.
CREATE UNIQUE INDEX "outbox_events_idempotency_key_uniq"
    ON "outbox_events"("idempotency_key")
    WHERE "idempotency_key" IS NOT NULL;
