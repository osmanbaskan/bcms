# BCMS Operasyon — Docker Compose

Proje tamamen **Docker Compose** ile yönetilmektedir. `systemd`, `ng serve`, `tsx watch` kullanılmaz.

## Günlük Komutlar

```bash
# Durum
docker compose ps

# Loglar
docker compose logs -f
docker compose logs -f api
docker compose logs -f worker
docker compose logs -f opta-watcher

# Tüm servisleri başlat
docker compose up -d

# Kod değişikliğinden sonra API + worker yeniden build et
docker compose up -d --build api worker

# Servisi yeniden başlat (build'siz)
docker compose restart api
docker compose restart worker

# Durdur
docker compose down

# Smoke test
npm run smoke:api
```

## Konteyner Yapısı

| Servis | Konteyner | Görev |
|---|---|---|
| `api` | bcms_api | HTTP, Swagger, health — worker yok |
| `worker` | bcms_worker | ingest, bxf, notifications consumer |
| `opta-watcher` | bcms_opta_watcher | SMB → /api/v1/opta/sync |
| `web` | bcms_web | Angular (nginx) |
| `postgres` | bcms_postgres | PostgreSQL 16 |
| `rabbitmq` | bcms_rabbitmq | RabbitMQ 3.12 |
| `keycloak` | bcms_keycloak | Auth |
| `prometheus` | bcms_prometheus | Metrikler |
| `grafana` | bcms_grafana | Dashboard |

## Graceful Shutdown

Docker Compose `stop` veya `restart` komutlarında:
- API: `SIGTERM` → Fastify kapatılır, max 30 sn (stop_grace_period)
- Worker: `SIGTERM` → max 60 sn bekler (devam eden ingest işlemi için)

Bu sayede yayın sırasında restart yapıldığında aktif DB transaction'ları ve ingest işlemleri yarıda kesilmez.

## Health Endpoint

```bash
curl -fsS http://127.0.0.1:3000/health
```

Örnek yanıt (tam sağlıklı):
```json
{ "status": "ok", "checks": { "database": "ok", "rabbitmq": "ok", "opta": "ok" } }
```

Örnek yanıt (OPTA kopuk, API çalışmaya devam ediyor):
```json
{ "status": "degraded", "checks": { "database": "ok", "rabbitmq": "ok", "opta": "degraded" } }
```

## Adresler

- Web: `http://172.28.204.133:4200`
- API: `http://172.28.204.133:3000`
- Swagger: `http://172.28.204.133:4200/docs`
- RabbitMQ UI: `http://localhost:15672`
- Grafana: `http://localhost:3001`
- Prometheus: `http://localhost:9090`

## Frontend Operasyon Sekmeleri (Admin)

- `Stüdyo Planı` → `/studio-plan` (Haftalık Plan)
- `Haftalık Shift` → `/weekly-shift`
- `Provys İçerik Kontrol` → `/provys-content-control`
- `Ingest Planlama` → `/ingest` (plan tab + port görünümü tab)
- `Raporlama` → `/schedules/reporting` — **bağımsız** navigasyon öğesi, rapor tipi seçilebilir:
  - `Canlı Yayın Planı` — tarih aralığı veya lig/hafta filtresi, Excel + PDF export
  - `Stüdyo Kullanım Raporu` — tarih aralığı filtresi, Excel + PDF export (TOPLAM satırı)
  - `Ingest` — tarih aralığı filtresi, Excel + PDF export (TOPLAM satırı)

## Ingest Operasyon Mimarisi

- `worker` konteyneri ingest-worker ve ingest-watcher'ı çalıştırır.
- Kayıt port katalogu: `recording_ports` (varsayılan 1-44 + Metus1/Metus2 = 46 port).
- Plan kalıcılığı: `ingest_plan_items`.
- Port çakışması backend'de reddedilir.
- Port görünümü: bağımsız tarih seçici, 5 satırlı düzen, katalog sırası, tam ekran, zoom, print/export.
- Saat düzenleme: tüm kaynak tipler (live/studio/ingest-plan), 5 dk adımlı; kaydedilen saat kaynak saatini geçersiz kılar.
- Satır silme: `DELETE /api/v1/ingest/plan/:sourceKey` — ingest-plan'da satır tamamen kaldırılır, live/studio-plan'da port+not temizlenir.
- Burst polling: kayıt yapılınca veya Port Görünümü sekmesine geçince 6×10 sn sorgu atılır, değişiklik yoksa durur.
- Rapor endpointleri:
  - `GET /api/v1/ingest/plan/report?from=YYYY-MM-DD&to=YYYY-MM-DD` → JSON
  - `GET /api/v1/ingest/plan/report/export?from=YYYY-MM-DD&to=YYYY-MM-DD` → xlsx (TOPLAM satırı dahil)

## OPTA SMB Watcher

- Konteyner: `bcms_opta_watcher` (Python, `scripts/opta_smb_watcher.py`)
- Ağ: `network_mode: host` → API'ye `http://localhost:3000/api/v1` üzerinden erişir
- SMB'de değişen her `srml-*-results.xml` dosyası taranır; `POST /api/v1/opta/sync` ile senkronize edilir
- **Yarım yazma koruması**: `MTIME_SETTLE_SEC=5` — dosya son değişiminden 5 sn geçmeden işlenmez
- **Payload limit koruması**: `BATCH_SIZE=100` — maç listesi 100'er parçaya bölünür, her biri ayrı POST
- Tarama aralığı: `OPTA_POLL_INTERVAL` env (varsayılan 3600 sn)

```bash
docker compose logs -f opta-watcher
docker compose restart opta-watcher
```

## Canli Yayin Plani Kapsami

```text
schedules.usage_scope = 'live-plan'   → Sadece Raporlama + Ingest
schedules.usage_scope = 'broadcast'  → Normal yayın
```

## Web / Frontend

Angular production build `environment.prod.ts` kullanmalıdır (`skipAuth: false`). Bu `angular.json`'daki `fileReplacements` ile sağlanır.

**"dev-admin" görünüyorsa veya tüm API çağrıları 401 dönüyorsa:**

```bash
docker compose up -d --build web
```

Web imajı yeniden derlenir ve doğru environment ile çalışır.

Keycloak oturumu Docker restart sonrası geçersiz kalır (in-memory session). Tarayıcıda hard refresh (Ctrl+Shift+R) yapıp yeniden login olunmalıdır.

## LAN / Ağ Erişimi (Farklı Bilgisayardan)

`http://172.28.204.133:4200` adresine başka bir PC'den bağlanmak için iki yapılandırma gereklidir:

### 1. Keycloak redirect_uri

`bcms-web` client'ına LAN IP eklenmeli. Bu `infra/keycloak/realm-export.json`'da kalıcıdır.
Çalışan instance'a restart gerekmeden Keycloak Admin API ile uygulanabilir:

```bash
# Admin token al
TOKEN=$(curl -s -X POST "http://localhost:8080/realms/master/protocol/openid-connect/token" \
  -d "client_id=admin-cli&grant_type=password&username=admin&password=changeme_kc" \
  -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

# bcms-web client UUID'sini al
UUID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:8080/admin/realms/bcms/clients?clientId=bcms-web" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

# redirectUris ve webOrigins güncelle (içeriği ihtiyaca göre değiştir)
curl -s -o /dev/null -w "%{http_code}" -X PUT \
  "http://localhost:8080/admin/realms/bcms/clients/$UUID" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"clientId":"bcms-web","publicClient":true,"redirectUris":["http://localhost:4200/*","http://localhost/*","http://172.28.204.133:4200/*","http://172.28.204.133/*"],"webOrigins":["http://localhost:4200","http://localhost","http://172.28.204.133:4200","http://172.28.204.133"]}'
```

### 2. Token Issuer (Çoklu Issuer Desteği)

`KC_HOSTNAME_STRICT=false` Keycloak, token `iss` değerini isteği yapan IP'ye göre yazar.
API `KEYCLOAK_ALLOWED_ISSUERS` ile birden fazla issuer kabul eder — `.env` dosyasına şu satır eklenmiştir:

```bash
KEYCLOAK_ALLOWED_ISSUERS=http://172.28.204.133:8080/realms/bcms,http://localhost:8080/realms/bcms
```

Bu sayede hem `localhost:4200` hem `172.28.204.133:4200` üzerinden login yapılabilir.

## Güvenlik

### API Rate Limiting

API global olarak dakikada **300 istek** sınırına tabidir (`@fastify/rate-limit`).

- Sınır aşıldığında HTTP **429** döner, yanıtta kalan süre belirtilir.
- Muaf endpoint'ler: `/health` (Docker healthcheck) ve `/api/v1/ingest/callback` (worker iç çağrısı).
- nginx'in `X-Real-IP` header'ı gerçek istemci IP'si olarak tanınır.

### nginx Güvenlik Header'ları

`infra/docker/nginx.conf` — tüm frontend yanıtlarına eklenen header'lar:

```
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
X-XSS-Protection: 1; mode=block
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
X-Robots-Tag: noindex, nofollow
```

Web imajı rebuild edilmeden değişiklik yansımaz: `docker compose up -d --build web`

## Aktif Ops Scriptleri

```text
ops/scripts/bcms-build.sh           → packages/shared + api + web build
ops/scripts/bcms-restart.sh         → build + servis restart
ops/scripts/bcms-status.sh          → docker compose ps
ops/scripts/bcms-logs.sh            → docker compose logs
ops/scripts/bcms-opta-status.sh     → OPTA bağlantı durumu
ops/scripts/bcms-smoke-api.mjs      → API smoke test (npm run smoke:api ile çalıştır)
```

Kaldırılan scriptler (artık kullanılmıyor):
- `bcms-web-static-server.mjs` → nginx ile değiştirildi
- `bcms-db-bootstrap-empty.sh` → prisma migrate deploy kullanılıyor
- `bcms-install-cron-fallback.sh`, `bcms-install-user-services.sh` → Docker Compose gereksiz kıldı
- `bcms-supervisor*.sh` → Docker Compose restart policy kullanılıyor

## Veritabanı

```bash
# Migration (local DB açıkken)
npm run db:migrate:prod -w apps/api

# Prisma Studio
npm run db:studio -w apps/api
```

Prisma Client generate sorunu:
```bash
rm -rf node_modules/.prisma node_modules/@prisma/client node_modules/prisma
npm install prisma@5.22.0 @prisma/client@5.22.0
npm run db:generate -w apps/api
```
