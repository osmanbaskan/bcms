-- RenameEnum
ALTER TYPE "ScheduleStatus" RENAME TO "schedule_status";

-- DropForeignKey
ALTER TABLE "ingest_plan_items" DROP CONSTRAINT "ingest_plan_items_job_id_fkey";
ALTER TABLE "matches" DROP CONSTRAINT "matches_league_id_fkey";
ALTER TABLE "qc_reports" DROP CONSTRAINT "qc_reports_job_id_fkey";
ALTER TABLE "teams" DROP CONSTRAINT "teams_league_id_fkey";

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "matches" ADD CONSTRAINT "matches_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ingest_plan_items" ADD CONSTRAINT "ingest_plan_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ingest_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "qc_reports" ADD CONSTRAINT "qc_reports_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ingest_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
