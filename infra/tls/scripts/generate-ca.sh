#!/usr/bin/env bash
# BCMS Internal CA — 2-tier chain üretici
#
# Usage:
#   bash infra/tls/scripts/generate-ca.sh
#
# Çıktı:
#   - infra/tls/ca/root.{key,crt}                 (Root CA, 10 yıl, ECDSA P-384)
#   - infra/tls/ca/intermediate.{key,crt,csr}     (Intermediate CA, 5 yıl, ECDSA P-384)
#   - infra/tls/server/server.{key,crt,csr}       (Server cert, 2 yıl, ECDSA P-384)
#   - infra/tls/server/server-fullchain.crt       (Server + intermediate concatenation, nginx için)
#
# Network operasyonu: yok. Tüm openssl çağrıları lokal hesaplama.
# Idempotent: dosyalar varsa yeniden üretmez (re-üretim için ilgili dosyaları silip tekrar çalıştır).

set -euo pipefail

# Repo root'a göç et (script herhangi bir yerden çalıştırılabilir olsun)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

CA_DIR="ca"
SRV_DIR="server"
CONF_DIR="openssl"

mkdir -p "$CA_DIR" "$SRV_DIR"

echo "==> BCMS Internal CA Generator"
echo

# ── 1. Root CA ──────────────────────────────────────────────────────────────
if [ ! -f "$CA_DIR/root.key" ]; then
    echo "[1/3] Root CA üretiliyor (10 yıl, ECDSA P-384)..."
    openssl ecparam -genkey -name secp384r1 -out "$CA_DIR/root.key"
    chmod 600 "$CA_DIR/root.key"
    openssl req -x509 -new -key "$CA_DIR/root.key" -sha384 -days 3650 \
        -out "$CA_DIR/root.crt" \
        -config "$CONF_DIR/root.cnf" -extensions v3_ca
    echo "  ✓ Root CA: $CA_DIR/root.crt"
else
    echo "[1/3] Root CA zaten var (atlandı): $CA_DIR/root.crt"
fi

# ── 2. Intermediate CA ──────────────────────────────────────────────────────
if [ ! -f "$CA_DIR/intermediate.key" ]; then
    echo "[2/3] Intermediate CA üretiliyor (5 yıl, ECDSA P-384)..."
    openssl ecparam -genkey -name secp384r1 -out "$CA_DIR/intermediate.key"
    chmod 600 "$CA_DIR/intermediate.key"
    openssl req -new -key "$CA_DIR/intermediate.key" \
        -out "$CA_DIR/intermediate.csr" \
        -config "$CONF_DIR/intermediate.cnf"
    openssl x509 -req -in "$CA_DIR/intermediate.csr" \
        -CA "$CA_DIR/root.crt" -CAkey "$CA_DIR/root.key" -CAcreateserial \
        -out "$CA_DIR/intermediate.crt" -days 1825 -sha384 \
        -extfile "$CONF_DIR/intermediate.cnf" -extensions v3_intermediate_ca
    echo "  ✓ Intermediate CA: $CA_DIR/intermediate.crt"
else
    echo "[2/3] Intermediate CA zaten var (atlandı): $CA_DIR/intermediate.crt"
fi

# ── 3. Server cert ──────────────────────────────────────────────────────────
if [ ! -f "$SRV_DIR/server.key" ]; then
    echo "[3/3] Server cert üretiliyor (2 yıl, ECDSA P-384)..."
    openssl ecparam -genkey -name secp384r1 -out "$SRV_DIR/server.key"
    chmod 600 "$SRV_DIR/server.key"
    openssl req -new -key "$SRV_DIR/server.key" \
        -out "$SRV_DIR/server.csr" \
        -config "$CONF_DIR/server.cnf"
    openssl x509 -req -in "$SRV_DIR/server.csr" \
        -CA "$CA_DIR/intermediate.crt" -CAkey "$CA_DIR/intermediate.key" -CAcreateserial \
        -out "$SRV_DIR/server.crt" -days 730 -sha384 \
        -extfile "$CONF_DIR/server.cnf" -extensions v3_server
    cat "$SRV_DIR/server.crt" "$CA_DIR/intermediate.crt" > "$SRV_DIR/server-fullchain.crt"
    echo "  ✓ Server cert: $SRV_DIR/server.crt"
    echo "  ✓ Full chain: $SRV_DIR/server-fullchain.crt"
else
    echo "[3/3] Server cert zaten var (atlandı): $SRV_DIR/server.crt"
fi

echo

# ── 4. Verify chain ─────────────────────────────────────────────────────────
echo "==> Chain doğrulama:"
openssl verify -CAfile "$CA_DIR/root.crt" -untrusted "$CA_DIR/intermediate.crt" "$SRV_DIR/server.crt"
echo

# ── 5. Summary ──────────────────────────────────────────────────────────────
echo "==> Server cert SAN:"
openssl x509 -in "$SRV_DIR/server.crt" -text -noout | grep -A 1 "Subject Alternative Name"
echo
echo "==> Server cert validity:"
openssl x509 -in "$SRV_DIR/server.crt" -noout -dates
echo
echo "✓ Tüm sertifikalar üretildi."
echo
echo "Sonraki adımlar:"
echo "  1. Browser CA install için: $CA_DIR/root.crt dosyasını browser'ın 'Authorities' sekmesine yükle"
echo "  2. /etc/hosts dosyasına ekle:  127.0.0.1 beinport"
echo "  3. docker compose up -d --no-build --pull never web keycloak"
echo "  4. https://beinport/ açılır"
