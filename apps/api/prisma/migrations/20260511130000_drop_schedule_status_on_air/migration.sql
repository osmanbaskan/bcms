-- ScheduleStatus.ON_AIR hard delete (2026-05-11)
--
-- Why:
--   MCR sekmesi ve `/playout/*` endpoint'leri kaldırıldı (`0e10e62`).
--   Sonrasında bir schedule'ı `ON_AIR` durumuna geçirecek mekanizma yok.
--   `LivePlanEntry.IN_PROGRESS` canlı yayın source-of-truth oldu;
--   Schedule.status ON_AIR pratikte ölü enum değeri.
--
-- Karar (kullanıcı, 2026-05-11):
--   - ON_AIR enum'dan kaldırılır (hard delete).
--   - DB'de `schedules.status = 'ON_AIR'` satır sayısı 0 (pre-apply doğrulandı).
--   - Sahte mapping yasak: dashboard ON_AIR sayaçları kaldırıldı / sıfırlandı.
--   - OPTA cascade FROZEN_SCHEDULE_STATUSES listesinden ON_AIR çıkarıldı.
--
-- Pattern:
--   PostgreSQL native `ALTER TYPE ... DROP VALUE` desteği yoktur. Standart
--   yol: yeni enum oluştur, kolonu cast et, eski enum DROP, rename.
--   USING clause ON_AIR olmayan tüm değerleri korur (pre-apply count=0
--   olduğu için cast fail riski sıfır).

-- 1) Yeni enum (ON_AIR olmadan)
CREATE TYPE "schedule_status_new" AS ENUM ('DRAFT', 'CONFIRMED', 'COMPLETED', 'CANCELLED');

-- 2) Default'u geçici kaldır (rename sonrası geri eklenecek)
ALTER TABLE schedules ALTER COLUMN status DROP DEFAULT;

-- 3) Kolonu yeni enum tipine cast et
ALTER TABLE schedules
  ALTER COLUMN status TYPE "schedule_status_new"
  USING (status::text::"schedule_status_new");

-- 4) Eski enum DROP
DROP TYPE "schedule_status";

-- 5) Rename → canonical isim
ALTER TYPE "schedule_status_new" RENAME TO "schedule_status";

-- 6) Default'u geri ekle (Prisma model `@default(DRAFT)`)
ALTER TABLE schedules ALTER COLUMN status SET DEFAULT 'DRAFT';
