-- Mini schema fix (decision §3.5 K16, K-B3.20 follow-up, 2026-05-07):
-- live_plan_entries içinde team_1/team_2 kolonları yok; SCHED-B3a Schedule
-- create'te entry'den kopyalanacak alanlar olarak gerekli (K-B3.20 — Schedule
-- body'de team yazılmaz; entry'den kopya).
--
-- Nullable: M5-B2 schema entry create'te bu alanları zorunlu kılmıyordu;
-- mevcut entry'ler için NULL. UI gerekirse doldurur. OPTA selection (B3b)
-- akışında otomatik doldurma kararı ayrıca yapılır.

ALTER TABLE "live_plan_entries"
  ADD COLUMN "team_1_name" VARCHAR(200),
  ADD COLUMN "team_2_name" VARCHAR(200);
