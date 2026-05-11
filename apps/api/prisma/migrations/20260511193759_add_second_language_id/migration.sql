-- live_plan_technical_details.second_language_id (2026-05-11)
--
-- Why:
--   Canlı Yayın Plan "Düzenle" formu (görsel referans) "Yabancı Dil" alanı
--   içerir. Mevcut `language_id` ana dil, `second_language_id` ikinci/yabancı
--   dil. JSON/metadata workaround YASAK (Madde 5 K15 lock); kanonik kolon.
--   Aynı lookup tablosuna (live_plan_languages) FK; ayrı tablo gerekmez.
--
-- Karar (2026-05-11): teknik alan sayım 73 → 74. REQUIREMENTS doc §5.2 Ortak
-- grubunda kaydedildi. Audit plugin Prisma update üzerinden otomatik yakalar.

ALTER TABLE "live_plan_technical_details"
  ADD COLUMN "second_language_id" INTEGER;

-- FK live_plan_languages(id) — mevcut `language_id` FK paterni ile birebir:
-- ON DELETE RESTRICT ON UPDATE CASCADE. Lookup soft-delete (L5) DB seviyesinde
-- satırı kaldırmaz; FK RESTRICT sadece hard-purge senaryosunda devreye girer.
ALTER TABLE "live_plan_technical_details"
  ADD CONSTRAINT "lpt_second_language_fkey"
  FOREIGN KEY ("second_language_id")
  REFERENCES "live_plan_languages"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

CREATE INDEX "live_plan_technical_details_second_language_id_idx"
  ON "live_plan_technical_details"("second_language_id");
