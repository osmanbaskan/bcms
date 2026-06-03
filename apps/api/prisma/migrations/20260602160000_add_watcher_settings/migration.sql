-- Watcher izlenen klasör override'ları (Ayarlar > Bağlantılar).
-- TEK satır (id=1). Boş/null alan runtime'da env'e (PROVYS_WATCH_FOLDER /
-- ASRUN_WATCH_FOLDER) düşer. Watcher worker'da DB'yi ~30 sn'de bir okur;
-- klasör değişince canlı re-watch (restart yok). Yalnız SystemEng erişir.
--
-- ADDITIVE: yalnız CREATE TABLE — mevcut veriye/şemaya dokunmaz, DROP/RESET yok.

CREATE TABLE "watcher_settings" (
    "id"                  INTEGER       NOT NULL DEFAULT 1,
    "provys_watch_folder" TEXT,
    "asrun_watch_folder"  TEXT,
    "updated_by"          VARCHAR(100),
    "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watcher_settings_pkey" PRIMARY KEY ("id")
);
