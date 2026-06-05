-- CreateTable
CREATE TABLE "news_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "aa_api_user" VARCHAR(100),
    "aa_api_password" TEXT,
    "aa_api_base" VARCHAR(300),
    "aa_api_poll_seconds" INTEGER,
    "aa_api_filter_type" VARCHAR(40),
    "aa_api_filter_language" VARCHAR(40),
    "aa_api_filter_category" VARCHAR(120),
    "aa_api_enabled" BOOLEAN,
    "updated_by" VARCHAR(100),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "news_settings_pkey" PRIMARY KEY ("id")
);

