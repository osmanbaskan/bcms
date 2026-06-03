-- Restore V2 — Avid bağlantı ayarları (Ayarlar ekranından düzenlenebilir).
-- TEK satır (id=1). Boş/null alanlar runtime'da env'e (AVID_*) düşer
-- (avid.client.getAvidAdapter → applyAvidOverrides).
--
-- Ara + Restore tek user/pass (IPWS); Transfer ayrı Cloud UX URL+token.
-- Şifre/token düz metin (.env ile eş risk); API GET'te maskeli döner.
--
-- ADDITIVE: yalnız CREATE TABLE — mevcut veriye/şemaya dokunmaz, DROP/RESET yok.

CREATE TABLE "avid_settings" (
    "id"            INTEGER       NOT NULL DEFAULT 1,
    "interplay_url" TEXT,
    "avid_user"     VARCHAR(200),
    "avid_password" TEXT,
    "workspace"     TEXT,
    "cloudux_url"   TEXT,
    "cloudux_realm" TEXT,
    "cloudux_token" TEXT,
    "updated_by"    VARCHAR(100),
    "updated_at"    TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avid_settings_pkey" PRIMARY KEY ("id")
);
