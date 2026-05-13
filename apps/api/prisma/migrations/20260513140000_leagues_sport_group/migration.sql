-- leagues.sport_group + yeni sport ligleri (2026-05-13)
--
-- Why:
--   Yayın Planlama "Yeni Ekle" dropdown'unda OPTA ligleri/turnuvaları sport
--   grubuna göre gruplandırılır (futbol / tenis / motogp / rugby / formula1 /
--   basketbol). Mevcut "visible + sort_order" yapısının üstüne `sport_group`
--   alanı eklenir; UI mat-optgroup ile sınıflar.
--
-- Seed/backfill:
--   - Mevcut OPTA futbol kodları (opta-115, opta-8, opta-24, opta-388,
--     opta-104) → sport_group='football'
--   - Mevcut F1 (custom-f1) → 'formula1'
--   - Mevcut Tenis (custom-tennis) → 'tennis'
--   - Mevcut Basketbol (custom-tbl) → 'basketball'
--   - Diğer (legacy/ad-hoc OPTA satırları) → 'football' default
--   - Yeni: custom-motogp (motogp), custom-rugby (rugby) → visible=true, sort_order
--   - F1 paterniyle MotoGP takvim dosyası (MOTOGP_CALENDAR_2026.xml) SMB'ye
--     manuel düşürülür (parser hazırdır; takvim dosyası operatör tarafında).
--   - Rugby ru1_compfixtures.* OPTA SMB'den çekilir (watcher pattern eklenir).

-- 1. Kolon ekle
ALTER TABLE "leagues"
  ADD COLUMN "sport_group" VARCHAR(30) NOT NULL DEFAULT 'football';

-- 2. CHECK constraint — geçerli sport_group set
ALTER TABLE "leagues"
  ADD CONSTRAINT "leagues_sport_group_check"
  CHECK ("sport_group" IN ('football','tennis','motogp','rugby','formula1','basketball'));

-- 3. Mevcut özel kodları doğru gruba ata
UPDATE "leagues" SET "sport_group" = 'formula1'   WHERE "code" = 'custom-f1';
UPDATE "leagues" SET "sport_group" = 'tennis'     WHERE "code" = 'custom-tennis';
UPDATE "leagues" SET "sport_group" = 'basketball' WHERE "code" = 'custom-tbl';

-- 4. Yeni sport ligleri (visible=true, geriye uyumluluk sırasıyla devam)
INSERT INTO "leagues" ("code","name","country","sport_group","visible","sort_order","created_at","updated_at")
VALUES
  ('custom-motogp','MotoGP','Worldwide','motogp',true,9,NOW(),NOW()),
  ('custom-rugby','Rugby Union','Worldwide','rugby',true,10,NOW(),NOW())
ON CONFLICT ("code") DO UPDATE
  SET "sport_group" = EXCLUDED."sport_group",
      "visible"     = EXCLUDED."visible",
      "sort_order"  = EXCLUDED."sort_order";

-- 5. Index — sport_group + visible filtre için
CREATE INDEX "leagues_sport_group_visible_idx"
  ON "leagues" ("sport_group", "visible", "sort_order");
