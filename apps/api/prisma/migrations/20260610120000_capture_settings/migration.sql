-- Capture Web Service bağlantı ayarları (2026-06-10, Faz 0 — salt-okuma iskelet).
-- Tek satır (id=1). writeEnabled default FALSE: BCMS→Capture yazma anahtarı;
-- bu fazda yazma kodu yok, alan ileriye dönük. Additive — mevcut veriye dokunmaz.
CREATE TABLE "capture_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "ws_url" VARCHAR(300),
    "connection_enabled" BOOLEAN NOT NULL DEFAULT false,
    "write_enabled" BOOLEAN NOT NULL DEFAULT false,
    "poll_seconds" INTEGER NOT NULL DEFAULT 60,
    "updated_by" VARCHAR(100),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "capture_settings_pkey" PRIMARY KEY ("id")
);
