-- CreateTable
CREATE TABLE "matches" (
    "id" SERIAL NOT NULL,
    "league_id" INTEGER NOT NULL,
    "home_team_name" VARCHAR(100) NOT NULL,
    "away_team_name" VARCHAR(100) NOT NULL,
    "match_date" TIMESTAMPTZ NOT NULL,
    "week_number" INTEGER,
    "season" VARCHAR(20) NOT NULL,
    "venue" VARCHAR(200),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "schedules" ADD COLUMN "match_id" INTEGER;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "match_id" INTEGER;

-- CreateIndex
CREATE INDEX "matches_league_id_match_date_idx" ON "matches"("league_id", "match_date");

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;
