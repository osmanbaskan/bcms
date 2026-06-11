-- Provys SMB-direct (2026-06-11): provys_watch_folder smb:// olduğunda
-- kullanılacak kimlikler. Additive; mevcut satıra dokunmaz.
ALTER TABLE "watcher_settings" ADD COLUMN "provys_smb_user" VARCHAR(100);
ALTER TABLE "watcher_settings" ADD COLUMN "provys_smb_password" TEXT;
ALTER TABLE "watcher_settings" ADD COLUMN "provys_smb_domain" VARCHAR(100);
