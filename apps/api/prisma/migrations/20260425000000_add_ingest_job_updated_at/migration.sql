-- AlterTable: ingest_jobs — add updated_at column
ALTER TABLE "ingest_jobs" ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT NOW();
