-- EGS bülten dışa-aktarım ayarları (out + xml → SMB). Additive: news_settings'e kolon ekler.
ALTER TABLE "news_settings" ADD COLUMN "egs_export_enabled" BOOLEAN;
ALTER TABLE "news_settings" ADD COLUMN "egs_prompter_path" VARCHAR(400);
ALTER TABLE "news_settings" ADD COLUMN "egs_xml_path" VARCHAR(400);
ALTER TABLE "news_settings" ADD COLUMN "egs_smb_user" VARCHAR(100);
ALTER TABLE "news_settings" ADD COLUMN "egs_smb_password" TEXT;
ALTER TABLE "news_settings" ADD COLUMN "egs_smb_domain" VARCHAR(100);
