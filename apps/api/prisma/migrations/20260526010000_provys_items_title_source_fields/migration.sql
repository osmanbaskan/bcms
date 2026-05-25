-- Provys BXF ham title kaynak alanları — `title` derived display alan olarak
-- kalır; aşağıdaki kolonlar UI'da iki seviyeli görünüm (üst başlık / alt
-- başlık / metadata) yapabilmek için ham BXF kaynaklarını ayrı saklar.
-- Hepsi nullable; mevcut 37k satırda null kalır (backfill ayrı onay/iş).
ALTER TABLE "provys_items"
  ADD COLUMN IF NOT EXISTS "version_name"   VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS "episode_name"   VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS "event_title"    VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS "content_name"   VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS "program_name"   VARCHAR(500) NULL,
  ADD COLUMN IF NOT EXISTS "ad_type"        VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS "spot_type"      VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS "title_source"   VARCHAR(40)  NULL,
  ADD COLUMN IF NOT EXISTS "series_name"    VARCHAR(300) NULL,
  ADD COLUMN IF NOT EXISTS "episode_number" SMALLINT     NULL;
