-- CreateEnum
CREATE TYPE "news_bulletin_status" AS ENUM ('DRAFT', 'READY', 'ON_AIR', 'DONE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "news_story_type" AS ENUM ('PKG', 'VO', 'VOSOT', 'READER', 'LIVE', 'PHONE', 'CRAWL', 'ROLL');

-- CreateEnum
CREATE TYPE "news_lower_third_kind" AS ENUM ('KJ', 'SPOT');

-- CreateEnum
CREATE TYPE "news_wire_priority" AS ENUM ('FLASH', 'NORMAL');

-- CreateEnum
CREATE TYPE "news_mos_device_kind" AS ENUM ('MOS_TCP', 'VIZRT_REST', 'XML_FILE');

-- CreateEnum
CREATE TYPE "news_mos_action" AS ENUM ('KJ', 'SPOT', 'CRAWL', 'ROLL');

-- CreateEnum
CREATE TYPE "news_mos_job_status" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "news_bulletins" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "bulletin_code" VARCHAR(40),
    "bulletin_date" DATE NOT NULL,
    "on_air_minute" INTEGER NOT NULL,
    "anchor_name" VARCHAR(200),
    "news_group" VARCHAR(80),
    "status" "news_bulletin_status" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" VARCHAR(100) NOT NULL,
    "updated_by" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "news_bulletins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_stories" (
    "id" SERIAL NOT NULL,
    "bulletin_id" INTEGER,
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "title" VARCHAR(300) NOT NULL,
    "display_name" VARCHAR(300),
    "story_type" "news_story_type" NOT NULL DEFAULT 'READER',
    "clip_duration_sec" INTEGER NOT NULL DEFAULT 0,
    "anchor_name" VARCHAR(200),
    "description" TEXT,
    "prompter_text" TEXT,
    "news_group" VARCHAR(80),
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "locked_by" VARCHAR(100),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" VARCHAR(100) NOT NULL,
    "updated_by" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "news_stories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_lower_thirds" (
    "id" SERIAL NOT NULL,
    "story_id" INTEGER NOT NULL,
    "kind" "news_lower_third_kind" NOT NULL DEFAULT 'KJ',
    "order_index" INTEGER NOT NULL DEFAULT 0,
    "title" VARCHAR(300),
    "line1" VARCHAR(300),
    "line2" VARCHAR(300),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "news_lower_thirds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_wire_items" (
    "id" SERIAL NOT NULL,
    "source" VARCHAR(40) NOT NULL,
    "external_id" VARCHAR(200),
    "category" VARCHAR(120),
    "priority" "news_wire_priority" NOT NULL DEFAULT 'NORMAL',
    "headline" VARCHAR(500) NOT NULL,
    "body" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_story_id" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_wire_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_mos_devices" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "kind" "news_mos_device_kind" NOT NULL DEFAULT 'VIZRT_REST',
    "host" VARCHAR(200),
    "port" INTEGER,
    "mos_id" VARCHAR(120),
    "ncs_id" VARCHAR(120),
    "template_map" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "news_mos_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "news_mos_jobs" (
    "id" SERIAL NOT NULL,
    "story_id" INTEGER,
    "lower_third_id" INTEGER,
    "device_id" INTEGER,
    "action" "news_mos_action" NOT NULL,
    "payload_xml" TEXT,
    "status" "news_mos_job_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_by" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "news_mos_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "news_bulletins_bulletin_date_on_air_minute_idx" ON "news_bulletins"("bulletin_date", "on_air_minute");

-- CreateIndex
CREATE INDEX "news_bulletins_news_group_idx" ON "news_bulletins"("news_group");

-- CreateIndex
CREATE INDEX "news_bulletins_status_idx" ON "news_bulletins"("status");

-- CreateIndex
CREATE INDEX "news_stories_bulletin_id_order_index_idx" ON "news_stories"("bulletin_id", "order_index");

-- CreateIndex
CREATE INDEX "news_stories_news_group_idx" ON "news_stories"("news_group");

-- CreateIndex
CREATE INDEX "news_lower_thirds_story_id_order_index_idx" ON "news_lower_thirds"("story_id", "order_index");

-- CreateIndex
CREATE INDEX "news_wire_items_received_at_idx" ON "news_wire_items"("received_at");

-- CreateIndex
CREATE INDEX "news_wire_items_source_priority_idx" ON "news_wire_items"("source", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "news_wire_items_source_external_id_key" ON "news_wire_items"("source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "news_mos_devices_name_key" ON "news_mos_devices"("name");

-- CreateIndex
CREATE INDEX "news_mos_jobs_status_created_at_idx" ON "news_mos_jobs"("status", "created_at");

-- CreateIndex
CREATE INDEX "news_mos_jobs_story_id_idx" ON "news_mos_jobs"("story_id");

-- AddForeignKey
ALTER TABLE "news_stories" ADD CONSTRAINT "news_stories_bulletin_id_fkey" FOREIGN KEY ("bulletin_id") REFERENCES "news_bulletins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_lower_thirds" ADD CONSTRAINT "news_lower_thirds_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "news_stories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_mos_jobs" ADD CONSTRAINT "news_mos_jobs_story_id_fkey" FOREIGN KEY ("story_id") REFERENCES "news_stories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_mos_jobs" ADD CONSTRAINT "news_mos_jobs_lower_third_id_fkey" FOREIGN KEY ("lower_third_id") REFERENCES "news_lower_thirds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "news_mos_jobs" ADD CONSTRAINT "news_mos_jobs_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "news_mos_devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

