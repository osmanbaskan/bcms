-- leagues.visible + sort_order (2026-05-13)
--
-- Why:
--   Canlı Yayın Plan "Yeni Ekle" dialog'unda OPTA fixture lig/turnuva listesi
--   şu ana kadar opta.routes.ts içinde hardcoded `FEATURED` array ile
--   filtreleniyordu (8 sabit kod). Operatör görünür ligleri yönetemiyordu.
--
--   Bu migration `leagues` tablosuna `visible` (Boolean) + `sort_order` (Int)
--   kolonları ekler; admin yönetim endpoint'i ile bu alanlar PATCH edilir.
--   `/opta/fixture-competitions` artık WHERE visible=true filtresi kullanır.
--
-- Karar (2026-05-13):
--   - Yeni ligler default visible=false (operatör görünür yapana kadar
--     dropdown'da görünmez). Kontrolsüz büyüme önlenir.
--   - sort_order default 0; admin UI'dan int >= 0 değer set edilir.
--   - Geriye uyumluluk: mevcut hardcoded FEATURED 8 kod için
--     visible=true + sort_order set edilir (mevcut UX davranışı korunur).

ALTER TABLE "leagues"
  ADD COLUMN "visible"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0;

-- Geriye uyumluluk seed — opta.routes.ts:133 FEATURED listesi birebir.
UPDATE "leagues" SET "visible" = true,
  "sort_order" = CASE "code"
    WHEN 'opta-115'       THEN 1
    WHEN 'opta-388'       THEN 2
    WHEN 'opta-8'         THEN 3
    WHEN 'opta-24'        THEN 4
    WHEN 'opta-104'       THEN 5
    WHEN 'custom-f1'      THEN 6
    WHEN 'custom-tbl'     THEN 7
    WHEN 'custom-tennis'  THEN 8
    ELSE 0
  END
WHERE "code" IN (
  'opta-115','opta-388','opta-8','opta-24','opta-104',
  'custom-f1','custom-tbl','custom-tennis'
);

-- Composite index: visible + sort_order — /fixture-competitions sorgu
-- pattern'ine (WHERE visible=true ORDER BY sort_order) uyumlu.
CREATE INDEX "leagues_visible_sort_order_idx"
  ON "leagues" ("visible", "sort_order");
