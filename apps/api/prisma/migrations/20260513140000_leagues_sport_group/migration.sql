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
--     opta-104) → sport_group='football' (default'tan gelir)
--   - Mevcut F1 (custom-f1) → 'formula1'
--   - Mevcut Tenis (custom-tennis) → 'tennis'
--   - Mevcut Basketbol (custom-tbl) → 'basketball'
--   - Yeni: custom-motogp (motogp), custom-rugby (rugby) → visible=true, sort_order
--
-- Not (2026-05-13 revize): `leagues.code` üzerinde partial unique index var
-- (`WHERE deleted_at IS NULL`) — `ON CONFLICT (code)` PostgreSQL'de tam
-- constraint arıyor. Bu yüzden UPSERT yerine UPDATE + INSERT WHERE NOT EXISTS
-- pattern'i (predicate-safe).

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

-- 4. Yeni sport ligleri (predicate-safe upsert):
--    (a) varsa update; (b) yoksa insert.
UPDATE "leagues"
   SET "sport_group" = 'motogp', "visible" = true, "sort_order" = 9, "updated_at" = NOW()
 WHERE "code" = 'custom-motogp';

INSERT INTO "leagues" ("code","name","country","sport_group","visible","sort_order","created_at","updated_at")
SELECT 'custom-motogp','MotoGP','Worldwide','motogp',true,9,NOW(),NOW()
WHERE NOT EXISTS (SELECT 1 FROM "leagues" WHERE "code" = 'custom-motogp');

UPDATE "leagues"
   SET "sport_group" = 'rugby', "visible" = true, "sort_order" = 10, "updated_at" = NOW()
 WHERE "code" = 'custom-rugby';

INSERT INTO "leagues" ("code","name","country","sport_group","visible","sort_order","created_at","updated_at")
SELECT 'custom-rugby','Rugby Union','Worldwide','rugby',true,10,NOW(),NOW()
WHERE NOT EXISTS (SELECT 1 FROM "leagues" WHERE "code" = 'custom-rugby');

-- 5. Index — sport_group + visible filtre için
CREATE INDEX "leagues_sport_group_visible_idx"
  ON "leagues" ("sport_group", "visible", "sort_order");
