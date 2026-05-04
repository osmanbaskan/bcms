# BCMS TLS Internal CA — Tasarım Dokümanı

> **Tarih:** 2026-05-04
> **Durum:** Tasarım — implementation öncesi review aşaması
> **Scope:** BCMS production-ready HTTPS mimarisi (internal CA + reverse proxy + cert lifecycle)
> **Kapsam dışı:** Production deployment (Tekyon kurum CA'sı, public domain, Let's Encrypt — hepsi sonraki faz)

---

## 1. Hedef & Kapsam

### 1.1 İş gereksinimleri (kullanıcıdan gelen)
- **Browser tarayıcısından BCMS'e erişim:** `https://beinport/` ile, hiç port numarası olmadan
- **Sadece şirket içi kullanım:** Public internet exposure yok
- **HTTPS zorunlu:** Plain HTTP kabul edilemez
- **En profesyonel sistem:** Production-grade kalite, "kabul edilmiş tehlikeli alışkanlık" üretmeyen yapı
- **Tasarım fazı, local-only:** Tekyon kurum network'üne dokunulmaz; LAN/DNS/IT operasyonu yok

### 1.2 Teknik gereksinimler
- TLS 1.2+ (1.0/1.1 kapalı)
- Modern cipher suite (AEAD, forward secrecy)
- HTTP → HTTPS redirect
- HSTS, CSP, security headers
- Single-label hostname (`beinport`) — hosts file ile resolve
- Reverse proxy ile path-based routing (frontend, API, Keycloak hepsi tek hostname altında)
- Internal CA chain (root + intermediate + end-cert) — endüstri standardı 2-tier yapı
- Cert lifecycle dokümante (renewal, revocation prosedürü)

### 1.3 Kapsam dışı (production'a)
- Tekyon kurum CA entegrasyonu (network koordinasyonu gerek)
- Public DNS / Let's Encrypt (network)
- LAN'daki diğer makinelere otomatik CA dağıtımı (group policy / MDM)
- Cert revocation list (CRL) hosting
- Cert expiry monitoring (alertmanager kurulumu sonra)

---

## 2. Mimari

### 2.1 Yeni network topolojisi

```
                    ┌─────────────────────────────────────┐
                    │  User Browser                       │
                    │  https://beinport/                  │
                    └──────────────┬──────────────────────┘
                                   │ TLS (port 443)
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  nginx (web container)              │
                    │  - Listen 80 → 301 redirect 443     │
                    │  - Listen 443 with TLS              │
                    │  - HSTS + security headers          │
                    │  - Path-based routing:              │
                    └──────┬──────────┬─────────┬─────────┘
                           │          │         │
              /api/v1/*    │          │ /realms/* /admin/*
              /webhooks/*  │          │ /resources/* /js/*
              /docs        │          │
              /health      │          │
                           ▼          ▼          ▼ /**
                    ┌──────────┐  ┌──────────┐  ┌──────────┐
                    │ api:3000 │  │keycloak  │  │ static   │
                    │ (HTTP)   │  │ :8080    │  │ files    │
                    └──────────┘  │ (HTTP,   │  │ (SPA)    │
                                  │  edge    │  └──────────┘
                                  │  mode)   │
                                  └──────────┘
                          (BCMS Docker network — bcms_net)
                          (containers arası HTTP, internal)
```

**TLS termination edge'de:** Tüm dış trafik HTTPS olarak nginx'e gelir, decode edilir, sonra Docker network içinde HTTP olarak proxy'lenir. Bu standart pattern; Docker network izole olduğu için iç plain HTTP güvenlik açığı değildir.

### 2.2 Path routing

| Path prefix | Hedef | Açıklama |
|---|---|---|
| `/api/v1/*` | `api:3000` | BCMS REST API |
| `/webhooks/*` | `api:3000` | Ingest callback, OPTA sync |
| `/docs` | `api:3000` | Swagger UI (HIGH-API-010 ile gate'lenecek) |
| `/health` | `api:3000` | Health endpoint |
| `/metrics` | (nginx 403) | Prometheus metric'leri sadece internal — dış erişim engelle |
| `/realms/*` | `keycloak:8080` | Keycloak realm endpoints (token, userinfo, etc.) |
| `/admin/*` | `keycloak:8080` | Keycloak admin console |
| `/resources/*` | `keycloak:8080` | Keycloak static resources |
| `/js/*` | `keycloak:8080` | Keycloak JS bundles |
| `/robots.txt` | `keycloak:8080` | Keycloak robots |
| `/realms/*/protocol/*` | `keycloak:8080` | OIDC protocol endpoints |
| `/` (catch-all) | static files | Angular SPA, `try_files $uri /index.html` |

**Not:** Keycloak path'leri reverse proxy mode'da `/auth/` prefix kaldırılmış (Keycloak 17+ default). `KC_HTTP_RELATIVE_PATH` boş bırakılır.

---

## 3. Tasarım Kararları (gerekçeli)

### 3.1 CA Hierarchy — 2-tier (Root + Intermediate)

| Seviye | Validity | Algoritma | Kullanım |
|---|---|---|---|
| **Root CA** | 10 yıl | ECDSA P-384 / SHA-384 | Sadece intermediate CA imzalar; private key offline saklanır |
| **Intermediate CA** | 5 yıl | ECDSA P-384 / SHA-384 | Server cert'leri imzalar; online operasyonel kullanım |
| **End-cert (server)** | 2 yıl | ECDSA P-384 / SHA-384 | nginx'in kullandığı cert |

**Gerekçe:**
- 2-tier industry standard. Root compromise → tüm güven yok değil; intermediate revoke yeterli.
- ECDSA P-384: RSA 4096-eşdeğeri güç, 1/4 boyut, daha hızlı. Tüm modern tarayıcı destekler. Dezavantaj yok.
- SHA-384: ECDSA P-384 ile uyumlu hash. SHA-256 da kullanılabilirdi ama SHA-384 simetrik tercih.
- Validity süreleri: Modern best practice. Daha uzun = güvenlik zayıflar; daha kısa = renewal yükü.

### 3.2 Cert SAN listesi

```
DNS:
  - beinport
  - localhost

IP:
  - 127.0.0.1
  - 172.28.204.133  (host LAN IP — kullanıcının "IP ile erişim" tercihi için)
```

**Gerekçe:**
- `beinport`: ana hostname (single-label, kullanıcı kararı)
- `localhost` + `127.0.0.1`: host makinesinden test/erişim
- `172.28.204.133`: kullanıcı daha önce "IP ile de erişebilmek isterim" demişti; LAN binding zaten var, cert SAN'a eklenmesi sadece dokümantasyon. Bu IP cert'te olmasa bile binding çalışır ama browser cert validation'da SAN mismatch hatası verir.

**Production'a transition:** SAN listesi production hostname'lere göre yenilenir, cert tekrar üretilir.

### 3.3 Hosts file mekanizması

`beinport` single-label. Browser DNS query'si yapar:
- LAN DNS: cevap yok (Tekyon DNS'e kayıt eklenmemiş — kuralı ihlal etmeyiz)
- Hosts file: lokal mapping
- Default: NXDOMAIN, browser web search'e yönlendirebilir

Çözüm: Her erişen makinenin `hosts` dosyasına manuel entry:

```
# Linux/Mac: /etc/hosts
# Windows:   C:\Windows\System32\drivers\etc\hosts
127.0.0.1     beinport
# veya başka makineden bağlanılacaksa:
172.28.204.133  beinport
```

**Solo dev fazı:** Sadece host makinedeki `/etc/hosts`'a eklenir.
**Multi-user fazı:** README/docs prosedürü.
**Production:** Tekyon DNS'e A record (ayrı network koordinasyon iş).

### 3.4 nginx TLS config

**Modern hardening:**

```nginx
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
ssl_session_cache shared:SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
ssl_stapling on;       # OCSP — internal CA için anlamsız ama production için hazır
ssl_stapling_verify on;

add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "DENY" always;            # SAMEORIGIN'den DENY'a — Keycloak iframe yok
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';" always;
```

**Not — CSP `'unsafe-inline'`:** Angular runtime + Material inline style'lar gereği. Strict CSP için Angular `provideExperimentalCSP` veya nonce-based CSP gerekir; bu ayrı bir refactor (audit'e follow-up). Şimdilik temel CSP.

**Not — HSTS `includeSubDomains`:** `beinport` single-label, subdomain yok. Yine de pattern korunur (production'a hazır).

### 3.5 Keycloak proxy mode

Yeni env:
```
KC_PROXY=edge                     # Reverse proxy arkasında, X-Forwarded-Proto'ya güven
KC_HOSTNAME=beinport
KC_HOSTNAME_STRICT=true           # beinport ile gelmeyen istekleri reddet
KC_HOSTNAME_STRICT_HTTPS=true     # HTTPS zorunlu
KC_HTTP_RELATIVE_PATH=/           # /auth prefix yok (Keycloak 17+ default)
KC_HTTP_ENABLED=true              # Internal HTTP (Docker network içi); external HTTPS nginx'te
```

`KC_HTTP_ENABLED=true` görünüşte HIGH-INF-003 ihlali ama bağlam farklı:
- Internal Docker network izole
- TLS termination nginx'te
- Edge mode header validation devrede
- Production-standard pattern

### 3.6 Cert dosya yönetimi

**Yöntem: Docker bind-mount (Dockerfile-baked DEĞİL)**

Cert ve nginx config dosyaları docker-compose volume mount ile container içine ödünç verilir. Image rebuild gerekmez — bu network operasyonu (`npm install`, `docker pull`) tetikleme riskini sıfıra indirir. Tasarım fazı için doğru yaklaşım; production'a geçişte Dockerfile-baked alternatife geçilebilir (ayrı follow-up PR).

**Repo'da (committed):**
- `infra/tls/ca/root.crt` — public root cert
- `infra/tls/ca/intermediate.crt` — public intermediate cert
- `infra/tls/server/server.crt` — public server cert
- `infra/tls/server/server-fullchain.crt` — server + intermediate concatenation
- `infra/tls/openssl/*.cnf` — config files (reproducible)
- `infra/tls/scripts/generate-ca.sh` — generation script
- `infra/tls/README.md` — prosedür

**Repo dışı (`.gitignore`):**
- `infra/tls/ca/root.key`
- `infra/tls/ca/intermediate.key`
- `infra/tls/server/server.key`
- `infra/tls/ca/*.srl` (serial number files)

**Gerekçe:** Public cert'ler reproducible build için repo'da. Private key'ler asla repo'da olmaz; `.gitignore` ile korunur, host'ta veya secret manager'da yaşar. Tasarım fazında local PC'de tutulur.

**Container'a aktarım:** docker-compose.yml web servisinde `volumes:` altında bind mount:

```yaml
volumes:
  - ./infra/tls/server/server-fullchain.crt:/etc/nginx/tls/server-fullchain.crt:ro
  - ./infra/tls/server/server.key:/etc/nginx/tls/server.key:ro
  - ./infra/docker/nginx.conf:/etc/nginx/conf.d/default.conf:ro
```

`:ro` (read-only) — container cert'i değiştiremez.

---

## 4. Implementation Plan (file-by-file)

### 4.1 Yeni dosyalar

| Dosya | İçerik |
|---|---|
| `infra/tls/openssl/root.cnf` | Root CA openssl config |
| `infra/tls/openssl/intermediate.cnf` | Intermediate CA openssl config |
| `infra/tls/openssl/server.cnf` | Server cert openssl config (SAN listesi burada) |
| `infra/tls/scripts/generate-ca.sh` | One-shot script: 3 cert + chain üretir |
| `infra/tls/README.md` | Prosedür: cert üretimi, browser CA install, renewal |
| `infra/tls/.gitignore` | `*.key`, `*.srl` |
| `infra/docker/nginx-tls.conf` | YENİ nginx config (TLS + path routing) — `nginx.conf` replace edilir |

### 4.2 Değişen dosyalar

| Dosya | Değişiklik |
|---|---|
| `infra/docker/nginx.conf` | Replace edilir (yeni TLS-aware config); volume mount ile container'a ödünç verilir, image rebuild yok |
| `infra/docker/web.Dockerfile` | **Değişmez** (volume mount yaklaşımı; production'da Dockerfile-baked'e geçiş ayrı PR) |
| `docker-compose.yml` (web) | Ports: `4200:80` → `80:80` + `443:443`; `volumes:` bölümü eklenir (cert + nginx.conf bind mount) |
| `docker-compose.yml` (keycloak) | `ports:` bloğu kaldırılır (artık dış ağdan erişim yok); `KC_PROXY=edge`, `KC_HOSTNAME=beinport`, `KC_HTTP_RELATIVE_PATH=/`, `KC_HOSTNAME_STRICT=true` env eklenir |
| `.env` | `BCMS_KEYCLOAK_PUBLIC_URL=https://beinport`, `KEYCLOAK_ALLOWED_ISSUERS=https://beinport/realms/bcms,http://localhost:8080/realms/bcms` (localhost iç network için fallback), `CORS_ORIGIN=https://beinport`, `KC_HOSTNAME_PORT=443` |
| `.env.example` | Aynı değişiklikler (placeholder olarak) |
| `apps/web/src/environments/environment.ts` | `keycloak.url = 'https://beinport'`, `apiUrl = '/api/v1'` (zaten relative) |
| `apps/web/src/environments/environment.prod.ts` | Aynı |
| `.gitignore` | `infra/tls/**/*.key`, `infra/tls/**/*.srl` ekle |

### 4.3 Nginx TLS config draft

```nginx
# HTTP → HTTPS redirect
server {
    listen 80 default_server;
    server_name _;
    return 301 https://$host$request_uri;
}

# Main HTTPS server
server {
    listen 443 ssl http2;
    server_name beinport localhost;

    # TLS
    ssl_certificate /etc/nginx/tls/server-fullchain.crt;
    ssl_certificate_key /etc/nginx/tls/server.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;
    ssl_stapling on;
    ssl_stapling_verify on;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "geolocation=(), microphone=(), camera=()" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none';" always;
    add_header X-Robots-Tag "noindex, nofollow" always;

    root /usr/share/nginx/html;
    index index.html;
    client_max_body_size 10m;

    # Keycloak — reverse proxy
    location ~ ^/(realms|admin|resources|js|robots\.txt) {
        proxy_pass http://keycloak:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_buffer_size 128k;
        proxy_buffers 4 256k;
        proxy_busy_buffers_size 256k;
    }

    # API
    location /api/ {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 180s;
    }

    location /webhooks/ {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /docs {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /health {
        proxy_pass http://api:3000;
        proxy_set_header Host $host;
    }

    # Block /metrics from external access (Prometheus pulls via internal Docker network)
    location /metrics {
        deny all;
        return 403;
    }

    # Static assets
    location = /assets/runtime-config.js {
        add_header Cache-Control "no-store";
        try_files $uri =404;
    }
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # Angular SPA fallback
    location / {
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript application/x-javascript text/xml application/xml text/javascript;
}
```

---

## 5. CA Generation Procedure

### 5.1 Script: `infra/tls/scripts/generate-ca.sh`

```bash
#!/usr/bin/env bash
# BCMS Internal CA — 2-tier chain üretici
# Usage: bash infra/tls/scripts/generate-ca.sh
# Çalıştırıldıktan sonra:
#   - infra/tls/ca/root.{key,crt} (root CA, 10 yıl)
#   - infra/tls/ca/intermediate.{key,crt} (intermediate CA, 5 yıl)
#   - infra/tls/server/server.{key,crt,csr} (server cert, 2 yıl)
#   - infra/tls/server/server-fullchain.crt (server + intermediate)
set -euo pipefail
cd "$(dirname "$0")/.."

CA_DIR="ca"
SRV_DIR="server"
CONF_DIR="openssl"

mkdir -p "$CA_DIR" "$SRV_DIR"

# ── 1. Root CA ──────────────────────────────────────────────────────────────
if [ ! -f "$CA_DIR/root.key" ]; then
    openssl ecparam -genkey -name secp384r1 -out "$CA_DIR/root.key"
    chmod 600 "$CA_DIR/root.key"
    openssl req -x509 -new -key "$CA_DIR/root.key" -sha384 -days 3650 \
        -out "$CA_DIR/root.crt" \
        -config "$CONF_DIR/root.cnf" -extensions v3_ca
    echo "✓ Root CA created (10y)"
fi

# ── 2. Intermediate CA ──────────────────────────────────────────────────────
if [ ! -f "$CA_DIR/intermediate.key" ]; then
    openssl ecparam -genkey -name secp384r1 -out "$CA_DIR/intermediate.key"
    chmod 600 "$CA_DIR/intermediate.key"
    openssl req -new -key "$CA_DIR/intermediate.key" \
        -out "$CA_DIR/intermediate.csr" \
        -config "$CONF_DIR/intermediate.cnf"
    openssl x509 -req -in "$CA_DIR/intermediate.csr" \
        -CA "$CA_DIR/root.crt" -CAkey "$CA_DIR/root.key" -CAcreateserial \
        -out "$CA_DIR/intermediate.crt" -days 1825 -sha384 \
        -extfile "$CONF_DIR/intermediate.cnf" -extensions v3_intermediate_ca
    echo "✓ Intermediate CA created (5y)"
fi

# ── 3. Server cert ──────────────────────────────────────────────────────────
if [ ! -f "$SRV_DIR/server.key" ]; then
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
    echo "✓ Server cert created (2y)"
fi

# ── 4. Verify chain ─────────────────────────────────────────────────────────
openssl verify -CAfile "$CA_DIR/root.crt" -untrusted "$CA_DIR/intermediate.crt" "$SRV_DIR/server.crt"
echo "✓ Chain verified"

echo
echo "Sertifikalar üretildi. Browser'a yüklemek için:"
echo "  $CA_DIR/root.crt — bu dosyayı browser'ın 'Authorities' sekmesine import et"
echo
echo "Server cert SAN:"
openssl x509 -in "$SRV_DIR/server.crt" -text -noout | grep -A 1 "Subject Alternative Name"
```

### 5.2 openssl config örnekleri

`infra/tls/openssl/server.cnf` (en kritik — SAN listesi burada):

```ini
[req]
distinguished_name = req_distinguished_name
prompt = no

[req_distinguished_name]
CN = beinport
O  = BCMS Internal
C  = TR

[v3_server]
basicConstraints       = critical, CA:FALSE
keyUsage               = critical, digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth
subjectAltName         = @alt_names
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid:always

[alt_names]
DNS.1 = beinport
DNS.2 = localhost
IP.1  = 127.0.0.1
IP.2  = 172.28.204.133
```

---

## 6. Verify Checklist (post-implementation)

### 6.1 Local-only verify (network kuralı uyumlu)

```bash
# 1. Cert chain doğrulama
openssl verify -CAfile infra/tls/ca/root.crt \
  -untrusted infra/tls/ca/intermediate.crt \
  infra/tls/server/server.crt

# 2. Server cert SAN inspection
openssl x509 -in infra/tls/server/server.crt -text -noout | grep -A 5 "Subject Alternative Name"

# 3. nginx config syntax (container içinde)
docker exec bcms_web nginx -t

# 4. nginx 80 redirect
curl -sI http://127.0.0.1/ | grep -i "Location: https://"

# 5. nginx 443 TLS (CA cert ile)
curl -s --cacert infra/tls/ca/root.crt --resolve beinport:443:127.0.0.1 \
  https://beinport/health
# Beklenen: API health response

# 6. API üzerinden token auth test (CA cert ile)
curl -s --cacert infra/tls/ca/root.crt --resolve beinport:443:127.0.0.1 \
  https://beinport/api/v1/channels/catalog -H "Authorization: Bearer $TOKEN"

# 7. Keycloak realm endpoint test
curl -s --cacert infra/tls/ca/root.crt --resolve beinport:443:127.0.0.1 \
  https://beinport/realms/bcms/.well-known/openid-configuration | jq .

# 8. TLS protokol/cipher inspection
docker exec bcms_web sh -c "echo | openssl s_client -connect localhost:443 -servername beinport 2>&1 | grep -E 'Protocol|Cipher'"

# 9. Security header check
curl -sI --cacert infra/tls/ca/root.crt --resolve beinport:443:127.0.0.1 \
  https://beinport/ | grep -E "Strict-Transport|X-Frame|Content-Security"

# 10. Eski portlar artık dış ağda yok (sadece local Docker network içi)
ss -tlnp | grep -E ":8080|:4200" && echo "FAIL: ports still exposed" || echo "PASS: 8080/4200 not on host"
```

### 6.2 User browser verify (sen yapacaksın)

1. `/etc/hosts`'a ekle: `127.0.0.1 beinport`
2. Browser'a CA install: `infra/tls/ca/root.crt` dosyasını "Authorities" sekmesinde "Trust this certificate for identifying websites" ile import et (Chrome: Settings → Privacy → Security → Manage certificates → Authorities)
3. `https://beinport/` aç → SPA yüklenir → login akışı başlar → Keycloak login form (`https://beinport/realms/bcms/...`) → giriş yap → SPA'ya redirect → channels listesi vb. çalışır
4. Network tab'da hiçbir yerde `:4200` veya `:8080` görünmemeli
5. Address bar'da yeşil kilit (kırık değil, "Not Secure" değil) görünmeli

---

## 7. Production Transition Notes

Tasarım fazından production'a geçiş **bir refactor değil, bir cert/config swap**:

| Tasarım fazı | Production fazı | Değişen |
|---|---|---|
| Local CA (BCMS internal) | Tekyon kurum CA veya commercial CA | `infra/tls/ca/*` swap |
| `beinport` single-label | `bcms.tekyon.com.tr` veya benzeri | `KC_HOSTNAME`, cert SAN, `.env`, frontend env |
| `/etc/hosts` mapping | Tekyon DNS A record | Network config (Tekyon IT) |
| Manuel browser CA install | Group policy / MDM | IT ekibi |
| Self-managed renewal | Otomatik (Tekyon IT cert lifecycle) | IT ekibi |

**Mimari kalır:** nginx reverse proxy, TLS termination, path routing, security headers, KC_PROXY=edge — hepsi production'da aynı şekilde çalışır. Yalnızca cert ve hostname değişir.

---

## 8. Risks & Mitigations

| Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|
| Browser'da single-label hostname web search'e düşer | Orta | Düşük | Hosts file zorunlu; README'de net talimat |
| Self-signed CA kullanıcı browser'ında kabul edilmemiş | Yüksek (ilk kurulum) | Yüksek (login akışı çalışmaz) | README'de step-by-step CA install talimatı |
| Cert expiry — 2 yıl sonra unutulursa kırılır | Orta | Yüksek (downtime) | Memory'e expiry tarihi notu; cert expiry monitoring follow-up (Prometheus) |
| Keycloak `KC_HOSTNAME_STRICT=true` sıkı; başka hostname ile gelen istek reddedilir | Düşük | Orta | Test prosedürünün bir parçası — başka hostname ile gelen istek reddedilmeli (kasıtlı) |
| `KC_HTTP_ENABLED=true` audit'te HIGH-INF-003 olarak işaretli | Yorum | Düşük | Bu bağlamda doğru pattern (edge mode); audit'e clarification notu |
| Frontend `keycloak.url` cache'lenmiş eski değer kullanıyor olabilir | Orta | Yüksek (login kırılır) | Tarayıcı cache temizliği talimatı; `runtime-config.js` cache-control no-store |
| nginx config syntax hatası → web container start fail | Düşük | Yüksek | `docker exec bcms_web nginx -t` test her deploy öncesi |
| `.env` değişikliği rebuild gerektirebilir | Düşük | Orta | Container restart yeterli (env runtime'da okunur) — verify et |

---

## 9. Tasarım Kararları (kullanıcı onaylı, 2026-05-04)

Implementation öncesi tüm kararlar netleşti:

### Q1 ✅ — LAN binding stratejisi: `0.0.0.0`
nginx 80 ve 443 portları host'ta tüm interface'lere bind edilir. LAN'da başka makineler `https://beinport/` ile (hosts file ekleyerek) veya `https://172.28.204.133/` ile bağlanabilir. Eski 8080/4200 tamamen kapatılır; saldırı yüzeyi sadece 80→443 redirect ve 443.

### Q2 ✅ — CSP: Basic CSP şimdi, strict CSP ayrı PR
Angular runtime + Material gereği `script-src 'self' 'unsafe-inline'`. Strict CSP (nonce-based) profesyonel hedef ama TLS PR'ına bundle'lamak risk karışıklığı. Ayrı PR olarak Phase 1 (Report-Only) → Phase 2 (Enforce) yaklaşımı ile yapılacak. Audit follow-up listesine eklendi.

### Q3 ✅ — Eski portlar: Tamamen kapat
`docker-compose.yml`'de keycloak `ports:` bloğu kaldırılır. Web `ports:` `4200:80` çıkarılır, yerine `80:80` ve `443:443` gelir. Audit CRIT-001/002 net kapanır. Debug ihtiyacında `docker exec` kullanılır.

### Q4 ✅ — hosts file scope: Q1=A nedeniyle her erişen cihazda
Q1 LAN binding'e izin verdiği için, LAN'da BCMS'e bağlanmak isteyen her cihazın `hosts` dosyasına entry gerekir:
- Aynı host: `127.0.0.1 beinport`
- LAN'daki başka cihaz: `172.28.204.133 beinport`

Production'a geçişte DNS A record bunun yerine geçer.

### Bonus — Cert dosya yöntemi: Volume mount
Dockerfile-baked yerine docker-compose volume mount kullanılır. Image rebuild yok → network operasyonu (npm install, docker pull) tetikleme riski sıfır. Tasarım fazına uygun. Production'a geçişte Dockerfile-baked alternatife geçiş ayrı follow-up PR.

### Bonus — Domain placeholders
Production transition design doc placeholder'lı yazılır (`<MAIN_DOMAIN>`, `<SUBDOMAIN>`). Kullanıcı production planlama aşamasında doldurur.

---

## 10. Implementation Sırası (atomik PR olarak)

**Network politikası:** Hiçbir adım network'e paket göndermez. `docker compose up -d --no-build --pull never` ile container recreate (mevcut image kullanılır, build/pull yok).

1. **`infra/tls/` infrastructure** (yeni dosyalar): openssl configs + generate script + .gitignore
2. **CA generation** (local script run): root.crt, intermediate.crt, server.crt + key'ler — `openssl` lokal hesaplama
3. **`infra/docker/nginx.conf`** replace (TLS-aware version, volume mount ile container'a yansır)
4. **`docker-compose.yml`** update (web ports + volume mounts; keycloak ports kaldırılır + KC_PROXY env)
5. **`.env` ve `.env.example`** update
6. **Frontend `environment.ts` ve `.prod.ts`** update
7. **`.gitignore`** update
8. **`infra/tls/README.md`** — prosedür (cert üretimi, browser CA install, renewal)
9. **`ops/REQUIREMENTS-TLS-PRODUCTION-TRANSITION.md`** — production planlama dokümanı (placeholder'lı domain isimleri)
10. **Type-check** (frontend) — `npx tsc --noEmit -p apps/web/tsconfig.json`
11. **Container recreate** — `docker compose up -d --no-build --pull never web keycloak` (build yok, pull yok)
12. **Local verify** (Section 6.1 checklist — sadece `127.0.0.1` ve `docker exec`)
13. **Audit doc update** (`BCMS_ULTRA_DETAILED_AUDIT_REPORT_2026-05-01.md` Section 9'a CRIT-001/002 + HIGH-INF-003 closure)
14. **Memory note** (cert expiry tarihi + production transition checklist)
15. **Single atomic commit** (tüm değişiklikler tek commit'te)
16. **Push: kullanıcı onayı bekler** — explicit izin olmadan push yok

Tüm bu adımlar **local PC'de** yapılır. Network gerektiren tek aşama: kullanıcı browser test'i (kullanıcının kendi makinesinde yapacağı, ben yapmıyorum).

---

## 11. References

- nginx TLS hardening: Mozilla SSL Configuration Generator (intermediate profile)
- OWASP Security Headers
- Keycloak proxy mode: official docs (`KC_PROXY=edge`)
- BCMS audit raporu: `BCMS_ULTRA_DETAILED_AUDIT_REPORT_2026-05-01.md` — CRIT-001, CRIT-002, HIGH-INF-003, HIGH-INF-004
- Existing design docs: `ops/REQUIREMENTS-HEALTHCHECK.md`, `ops/REQUIREMENTS-S3-BACKUP.md`

---

*Bu doküman implementation öncesi review içindir. Section 9'daki açık soruların cevabı + genel onay alındıktan sonra atomik PR olarak uygulanır. Network operasyonu ya yoktur (cert üretimi local) ya da kullanıcı browser test'i (kullanıcının kendi makinesinde).*
