-- Phase PR-X1 (2026-05-10): Signals backend hard delete.
--
-- Monitoring frontend hard delete edildi (commit 383506a); signals modülü
-- (signal.routes.ts + ingestPlanItem auto-incident producer'ı) kaldırıldı.
-- signal_telemetry tablosu artık writer/reader olmayan tam orphan; build-phase
-- DB'de 0 satır.
--
-- Bu migration:
--   1. CASCADE ile `signal_telemetry` tablosunu drop eder. CASCADE: tablo
--      üzerindeki constraint'ler (Channel FK), index'ler ve sequence'lar
--      otomatik temizlenir.
--   2. Postgres `signal_telemetry_status` enum tipini drop eder (lowercase
--      snake_case — Prisma schema'daki orijinal kebap-case mapping). Tablo
--      kolonu kalmadığı için DROP TYPE güvenli.
--
-- Veri kaybı: 0 satır → fiilen yok. Rollback için snapshot/backup standart;
-- ayrı bir reverse migration (CREATE TABLE) yazılmaz.

DROP TABLE IF EXISTS "signal_telemetry" CASCADE;
DROP TYPE IF EXISTS "signal_telemetry_status";
