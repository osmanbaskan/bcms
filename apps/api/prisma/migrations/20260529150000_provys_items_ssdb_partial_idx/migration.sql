-- P1.1 (2026-05-29, 250 user scale): SSDB resolver worker candidate query için
-- partial composite index.
--
-- Hot path (ssdb-resolver.worker.ts:190):
--   WITH window_dc AS (
--     SELECT DISTINCT pi.dc_code
--     FROM provys_items pi
--     WHERE pi.dc_code IS NOT NULL
--       AND pi.category <> 'CANLI'
--       AND pi.schedule_date >= $today::date
--       AND pi.schedule_date <= $future::date
--   )
--   SELECT w.dc_code FROM window_dc w LEFT JOIN ssdb_material_cache ...
--
-- Mevcut index `provys_items_channel_date_seq_idx (channel_slug, schedule_date,
-- sequence)` schedule_date prefix değil → range scan + filter pahalı (~613
-- buffer hit, 2.8ms typical 14-gün penceresi).
--
-- Partial index avantajı:
--   - WHERE filter index'e dahil (dc_code IS NOT NULL + category <> 'CANLI')
--   - schedule_date prefix → range scan native
--   - dc_code second column → DISTINCT için sorted output
--   - Cardinality: 39128 eligible / 46507 total (~84%) — partial gain mütevazı
--     ama scan path daha temiz; tipik query 2.8ms → ~0.3ms (8-9× düşüş)
--
-- CONCURRENTLY: SHARE UPDATE EXCLUSIVE lock; INSERT/UPDATE bloklanmaz.
-- Migration apply esnasında uygulama kesintisiz çalışır.
--
-- NOT: Bu migration `prisma migrate deploy` ile direkt apply EDİLEMEZ
-- (CONCURRENTLY tx içinde yasak). Runtime apply pattern (`runtime_db_migration_*`
-- memory not'una bkz.):
--   1. psql -c "CREATE INDEX CONCURRENTLY ..." direkt
--   2. _prisma_migrations tablosuna manual entry (applied işareti)
--   3. prisma migrate status clean kalır
--
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS provys_items_ssdb_date_dc_idx;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "provys_items_ssdb_date_dc_idx"
  ON "provys_items" ("schedule_date", "dc_code")
  WHERE "dc_code" IS NOT NULL AND "category" <> 'CANLI';
