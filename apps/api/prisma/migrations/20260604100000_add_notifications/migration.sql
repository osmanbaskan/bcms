-- CreateEnum
CREATE TYPE "notification_severity" AS ENUM ('info', 'warning', 'critical');

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "type" VARCHAR(80) NOT NULL,
    "severity" "notification_severity" NOT NULL DEFAULT 'info',
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT,
    "link" VARCHAR(300),
    "data" JSONB,
    "created_by" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_reads" (
    "notification_id" INTEGER NOT NULL,
    "user_id" VARCHAR(100) NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_reads_pkey" PRIMARY KEY ("notification_id","user_id")
);

-- CreateTable
CREATE TABLE "notification_types" (
    "key" VARCHAR(80) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "section" VARCHAR(60) NOT NULL,
    "required_groups" TEXT[],
    "severity" "notification_severity" NOT NULL DEFAULT 'info',
    "sound" VARCHAR(20) NOT NULL DEFAULT 'normal',
    "default_on" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_types_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "notification_subscriptions" (
    "user_id" VARCHAR(100) NOT NULL,
    "type_key" VARCHAR(80) NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "sound" VARCHAR(20),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_subscriptions_pkey" PRIMARY KEY ("user_id","type_key")
);

-- CreateIndex
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

-- CreateIndex
CREATE INDEX "notifications_type_idx" ON "notifications"("type");

-- CreateIndex
CREATE INDEX "notification_reads_user_id_idx" ON "notification_reads"("user_id");

-- CreateIndex
CREATE INDEX "notification_types_section_idx" ON "notification_types"("section");

-- CreateIndex
CREATE INDEX "notification_subscriptions_user_id_idx" ON "notification_subscriptions"("user_id");

-- AddForeignKey
ALTER TABLE "notification_reads" ADD CONSTRAINT "notification_reads_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
