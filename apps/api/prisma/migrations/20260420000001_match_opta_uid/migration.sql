ALTER TABLE "matches" ADD COLUMN "opta_uid" VARCHAR(50);
CREATE UNIQUE INDEX "matches_opta_uid_key" ON "matches"("opta_uid");
