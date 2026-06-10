-- Asrun-Merge (2026-06-10): gerçek yayın listesi — Provys CANLI (kilitli) +
-- asrun boşluk dolgusu. Additive; mevcut tablolara dokunmaz.
CREATE TABLE "asrun_merge_items" (
    "id" SERIAL NOT NULL,
    "channel_slug" VARCHAR(40) NOT NULL,
    "schedule_date" DATE NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "dc_code" VARCHAR(40),
    "title" VARCHAR(500) NOT NULL,
    "title_source" VARCHAR(20) NOT NULL DEFAULT 'ASRUN',
    "category" VARCHAR(20) NOT NULL,
    "origin" VARCHAR(20) NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "trimmed" BOOLEAN NOT NULL DEFAULT false,
    "start_detected" BOOLEAN NOT NULL DEFAULT false,
    "end_detected" BOOLEAN NOT NULL DEFAULT false,
    "source_asrun_id" INTEGER,
    "source_provys_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "asrun_merge_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "asrun_merge_channel_date_start_idx" ON "asrun_merge_items"("channel_slug", "schedule_date", "start_at");
CREATE INDEX "asrun_merge_schedule_date_idx" ON "asrun_merge_items"("schedule_date");
