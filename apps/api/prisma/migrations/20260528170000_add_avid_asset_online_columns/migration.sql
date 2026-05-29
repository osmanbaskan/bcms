-- Restore V2 — Avid Interplay binary online/offline flag (audit doc).
--
-- Avid Interplay metadata kataloğu; binary online (Avid'de) veya offline
-- (DIVA arşivinde) olabilir. Search worker AvidAsset.online'ı JSONB'ye yazar;
-- PATCH select endpoint whitelist'ten eşleşen asset'in online alanını
-- selected_asset_online'a kopyalar. Restore enqueue search'ten kopya alır;
-- worker adapter.requestRestore'a assetOnline param geçer.
--
-- online=true  → Interplay no-op DONE (binary zaten online; restore kısa)
-- online=false → DIVA'dan Avid'e binary download (asıl restore işi)
--
-- Tüm kolonlar nullable; eski satırlar NULL kalır (backfill yok — V2 yeni).

ALTER TABLE "search_jobs"
  ADD COLUMN "selected_asset_online" BOOLEAN;

ALTER TABLE "restore_jobs"
  ADD COLUMN "avid_asset_online" BOOLEAN;

ALTER TABLE "transfer_jobs"
  ADD COLUMN "avid_asset_online" BOOLEAN;
