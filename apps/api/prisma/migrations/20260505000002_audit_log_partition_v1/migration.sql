-- Madde 1 PR-1A (audit doc): AuditLog declarative range partitioning by timestamp.
--
-- Tasarım: ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md
-- Locked decisions:
--   - Monthly partition granularity
--   - Default partition var + monitoring (PR-1D)
--   - Maintenance window kabul (online migration tooling yok)
--   - audit_logs_legacy 7 gün saklanır
--   - Composite PK (id, timestamp) — pre-flight verify: kodda id-lookup yok
--
-- Adımlar:
--   1. Yeni partitioned audit_logs_v2 + composite PK
--   2. Sub-partitions (geriye 12 ay + ileriye 3 ay + default)
--   3. Index'ler her partition'a (PK aracılığıyla otomatik partition'a yansır)
--   4. Data copy (chunked değil; lokal/dev için tek-tx; prod'da gerekirse re-script)
--   5. Sequence sync + ownership
--   6. Swap (rename)
--
-- Out of scope: retention job refactor (PR-1B feature-detect), pre-create cron
-- (PR-1C), monitoring (PR-1D), legacy cleanup (PR-1E manuel ops).
--
-- Rollback: ops/RUNBOOK-AUDITLOG-PARTITION-ROLLBACK.md

-- ── 1. Partitioned tablo create ──────────────────────────────────────────────
CREATE TABLE "audit_logs_v2" (
    "id"             SERIAL NOT NULL,
    "entity_type"    VARCHAR(50) NOT NULL,
    "entity_id"      INTEGER NOT NULL,
    "action"         "audit_log_action" NOT NULL,
    "before_payload" JSONB,
    "after_payload"  JSONB,
    "user"           VARCHAR(100) NOT NULL,
    "ip_address"     VARCHAR(45),
    "timestamp"      TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
    "deleted_at"     TIMESTAMPTZ(6),
    PRIMARY KEY ("id", "timestamp")
) PARTITION BY RANGE ("timestamp");

-- ── 2. Sub-partitions (12 ay geriye + 3 ay ileriye + default) ────────────────
-- 2025-06 → 2026-08 (15 partition; current=2026-05)
CREATE TABLE "audit_logs_2025_06" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE "audit_logs_2025_07" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE "audit_logs_2025_08" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE "audit_logs_2025_09" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE "audit_logs_2025_10" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE "audit_logs_2025_11" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE "audit_logs_2025_12" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');
CREATE TABLE "audit_logs_2026_01" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE "audit_logs_2026_02" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE "audit_logs_2026_03" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE "audit_logs_2026_04" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE "audit_logs_2026_05" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE "audit_logs_2026_06" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE "audit_logs_2026_07" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE "audit_logs_2026_08" PARTITION OF "audit_logs_v2" FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

-- Default partition: pre-create cron failure güvenliği. PR-1D monitoring metric
-- bcms_audit_default_partition_rows ile gözlem.
CREATE TABLE "audit_logs_default" PARTITION OF "audit_logs_v2" DEFAULT;

-- ── 3. Index'ler (partition'lara local olarak yansır) ────────────────────────
CREATE INDEX "audit_logs_v2_entity_type_entity_id_idx" ON "audit_logs_v2" ("entity_type", "entity_id");
CREATE INDEX "audit_logs_v2_user_idx"                  ON "audit_logs_v2" ("user");
CREATE INDEX "audit_logs_v2_timestamp_idx"             ON "audit_logs_v2" ("timestamp");
-- deleted_at orphan kolon partial index (mevcut audit_logs_deleted_at_idx ile eşit semantik)
CREATE INDEX "audit_logs_v2_deleted_at_idx"            ON "audit_logs_v2" ("deleted_at") WHERE "deleted_at" IS NOT NULL;

-- ── 4. Data copy (eski → yeni) ───────────────────────────────────────────────
-- Lokal/dev'de tek-tx. Prod maintenance window'da chunked re-script gerekirse:
--   INSERT INTO audit_logs_v2 SELECT * FROM audit_logs WHERE timestamp >= ... LIMIT 100000;
INSERT INTO "audit_logs_v2" (
    "id", "entity_type", "entity_id", "action", "before_payload",
    "after_payload", "user", "ip_address", "timestamp", "deleted_at"
)
SELECT
    "id", "entity_type", "entity_id", "action", "before_payload",
    "after_payload", "user", "ip_address", "timestamp", "deleted_at"
FROM "audit_logs";

-- ── 5. Sequence sync + ownership ─────────────────────────────────────────────
-- audit_logs_v2_id_seq SERIAL ile otomatik oluştu. setval + ownership açık set:
SELECT setval(
    pg_get_serial_sequence('audit_logs_v2', 'id'),
    GREATEST(COALESCE((SELECT MAX("id") FROM "audit_logs_v2"), 0), 1),
    true
);
-- Ownership: sequence parent'a bağlı (SERIAL zaten yapar; explicit defansif).
ALTER SEQUENCE "audit_logs_v2_id_seq" OWNED BY "audit_logs_v2"."id";

-- ── 6. Swap (atomic; legacy önce rename → çakışma açılır → v2 takarken klin) ─
-- Legacy table + indexes + sequence isimlerini "audit_logs_legacy_*" yap.
-- Aksi halde v2'nin yeni adı production "audit_logs_*" ile çakışır.
ALTER TABLE  "audit_logs"                        RENAME TO "audit_logs_legacy";
ALTER INDEX  "audit_logs_entity_type_entity_id_idx" RENAME TO "audit_logs_legacy_entity_type_entity_id_idx";
ALTER INDEX  "audit_logs_user_idx"               RENAME TO "audit_logs_legacy_user_idx";
ALTER INDEX  "audit_logs_timestamp_idx"          RENAME TO "audit_logs_legacy_timestamp_idx";
ALTER INDEX  "audit_logs_deleted_at_idx"         RENAME TO "audit_logs_legacy_deleted_at_idx";
ALTER SEQUENCE "audit_logs_id_seq"               RENAME TO "audit_logs_legacy_id_seq";

-- V2 → production ismi (audit_logs)
ALTER TABLE  "audit_logs_v2"                          RENAME TO "audit_logs";
ALTER INDEX  "audit_logs_v2_entity_type_entity_id_idx" RENAME TO "audit_logs_entity_type_entity_id_idx";
ALTER INDEX  "audit_logs_v2_user_idx"                 RENAME TO "audit_logs_user_idx";
ALTER INDEX  "audit_logs_v2_timestamp_idx"            RENAME TO "audit_logs_timestamp_idx";
ALTER INDEX  "audit_logs_v2_deleted_at_idx"           RENAME TO "audit_logs_deleted_at_idx";
ALTER SEQUENCE "audit_logs_v2_id_seq"                 RENAME TO "audit_logs_id_seq";

-- ── 7. Sanity check (manual verify; migration runtime'ında çalıştırılmaz) ────
-- Migration deploy sonrası operatör manuel doğrulama için aşağıdaki sorgular:
--
--   -- Partition count + boundary'ler
--   SELECT child.relname, pg_get_expr(child.relpartbound, child.oid)
--   FROM pg_inherits JOIN pg_class child ON pg_inherits.inhrelid = child.oid
--   JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
--   WHERE parent.relname = 'audit_logs';
--
--   -- Sequence default insert sanity
--   INSERT INTO audit_logs (entity_type, entity_id, action, "user")
--     VALUES ('TEST', 1, 'CREATE', 'verify') RETURNING id, timestamp;
--   DELETE FROM audit_logs WHERE entity_type = 'TEST' AND "user" = 'verify';
--
--   -- Row count parity (legacy vs partitioned)
--   SELECT (SELECT COUNT(*) FROM audit_logs) AS new_count,
--          (SELECT COUNT(*) FROM audit_logs_legacy) AS legacy_count;
