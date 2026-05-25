-- 2026-05-25: Studio Plan hafta bazlı time range ayarı.
-- Slot rendering / export'a opt-in; mevcut slot'ları değiştirmez.
-- null = varsayılan 07:00-02:00 (frontend fallback).

ALTER TABLE "studio_plans"
  ADD COLUMN "time_range_start" VARCHAR(5),
  ADD COLUMN "time_range_end"   VARCHAR(5);
