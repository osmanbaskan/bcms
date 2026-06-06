-- Havuz haberinin kökeni (kopya ise) → aynı haber bir bültene tek kez eklenir.
ALTER TABLE "news_stories" ADD COLUMN "source_story_id" INTEGER;
CREATE INDEX "news_stories_bulletin_id_source_story_id_idx" ON "news_stories"("bulletin_id", "source_story_id");
