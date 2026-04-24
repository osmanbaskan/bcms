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

- `Stüdyo Planı` → `/studio-plan` (Haftalık Plan) + `/studio-plan/report` (Kullanım Raporu)
- `Haftalık Shift` → `/weekly-shift`
- `Provys İçerik Kontrol` → `/provys-content-control`
- `Ingest Planlama` → `/ingest` (plan tab + port görünümü tab)
- `Raporlama` → `/schedules/reporting` — Rapor tipi seçilebilir:
  - `Canlı Yayın Planı` — tarih aralığı veya lig/hafta filtresi, Excel + PDF export
  - `Stüdyo Kullanım Raporu` — tarih aralığı filtresi, Excel + PDF export

## Ingest Operasyon Mimarisi

- `worker` konteyneri ingest-worker ve ingest-watcher'ı çalıştırır.
- Kayıt port katalogu: `recording_ports` (varsayılan 1-44 + Metus1/Metus2 = 46 port).
- Plan kalıcılığı: `ingest_plan_items`.
- Port çakışması backend'de reddedilir.
- Port görünümü: 5 satırlı düzen, tam ekran, zoom, print/export.

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
