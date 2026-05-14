-- 2026-05-15: Manuel takım listesi destekli ligler için ayrı görünürlük alanı.
-- OPTA fixture dropdown filter alanı `visible` ile KARIŞMASIN — bu alan
-- yalnız Canlı Yayın Plan "Yeni Ekle / Manuel Giriş" lig dropdown'u için.
-- /api/v1/matches/leagues/manual endpoint
-- `manual_selectable = true AND teams.count > 0` filtreler.
ALTER TABLE "leagues"
  ADD COLUMN "manual_selectable" BOOLEAN NOT NULL DEFAULT FALSE;

-- TBL (custom-tbl) tek default açık lig: operatör 16 takımı seed etti,
-- manuel dropdown'da görünmesi beklenir. Diğer team kayıtları olan ligler
-- (Süper Lig, Premier, La Liga vb.) admin ekranından açılana kadar gizli.
UPDATE "leagues" SET "manual_selectable" = TRUE WHERE "code" = 'custom-tbl';
