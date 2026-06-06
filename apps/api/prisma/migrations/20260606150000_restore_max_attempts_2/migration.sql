-- Restore en fazla 2 kez denenir (önceki default 3). Yalnız yeni job'lar için
-- geçerli kolon default'u; mevcut satırlar değişmez. Worker cap'i de 2'ye çekildi.
ALTER TABLE "restore_jobs" ALTER COLUMN "max_attempts" SET DEFAULT 2;
