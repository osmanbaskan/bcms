-- Migration: shift_assignments tablosu (Haftalık Shift modülü)
--
-- BU MIGRATION BIR DR/REPLAY KURTARMA ÇALIŞMASIDIR (2026-05-01 audit):
-- DB'de uygulanmış (`_prisma_migrations` finished_at NOT NULL, applied_steps_count=1)
-- ama filesystem'de kayıp idi. shift_assignments tablosu Prisma `ShiftAssignment`
-- modeli + `weekly-shift.routes.ts` `prisma.shiftAssignment` çağrıları tarafından
-- kullanılıyor. FS'te migration olmadığı için yeni bir env'e `migrate deploy`
-- yapıldığında tablo yaratılmaz → kod runtime hatası verirdi.
--
-- DDL `\d+ shift_assignments` çıktısından reverse-engineer edildi (live psql).

CREATE TABLE IF NOT EXISTS "shift_assignments" (
  "id"          SERIAL                       NOT NULL,
  "user_id"     VARCHAR(100)                 NOT NULL,
  "user_name"   VARCHAR(100)                 NOT NULL,
  "user_group"  VARCHAR(50)                  NOT NULL,
  "week_start"  VARCHAR(10)                  NOT NULL,
  "day_index"   INTEGER                      NOT NULL,
  "start_time"  VARCHAR(5),
  "end_time"    VARCHAR(5),
  "type"        VARCHAR(20)                  NOT NULL,
  "created_at"  TIMESTAMP(6) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "updated_at"  TIMESTAMP(6) WITHOUT TIME ZONE NOT NULL DEFAULT now(),
  "deleted_at"  TIMESTAMP(3) WITHOUT TIME ZONE,

  CONSTRAINT "shift_assignments_pkey" PRIMARY KEY ("id")
);

-- Unique: kullanıcı bazında haftanın günü için tek atama
CREATE UNIQUE INDEX IF NOT EXISTS "shift_assignments_user_id_week_start_day_index_key"
  ON "shift_assignments" ("user_id", "week_start", "day_index");

-- Indexler — sorgu desenleri:
-- 1) belirli kullanıcı için haftalık takvim
CREATE INDEX IF NOT EXISTS "idx_shift_user_week"
  ON "shift_assignments" ("user_id", "week_start");

-- 2) belirli haftada grubun tüm assignment'ları
CREATE INDEX IF NOT EXISTS "idx_shift_week_group"
  ON "shift_assignments" ("week_start", "user_group");
