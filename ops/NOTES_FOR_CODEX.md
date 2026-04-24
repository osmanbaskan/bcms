# Notes For Future Codex Sessions

## Mimari Kurallar (Değiştirilmez)

1. **API/Worker ayrıştırması**: `api` servisi `BCMS_BACKGROUND_SERVICES=none` ile çalışır. Worker servisi `notifications,ingest-worker,ingest-watcher,bxf-watcher` çalıştırır. OPTA Python watcher ayrı konteyner. Bu ayrım bozulmamalı.
2. **Graceful shutdown**: `server.ts`'de SIGTERM/SIGINT → `app.close()` → 30 sn timeout. Worker için 60 sn. `--force` veya anında kill önerilmez.
3. **usageScope kanonik**: `schedules.usage_scope` DB kolonudur. Metadata JSON filtresi yoktur. Ham SQL köprüsü eklenmez.
4. **Nginx static serve**: Angular dosyaları `infra/docker/web.Dockerfile` → nginx:alpine ile sunulur. `bcms-web-static-server.mjs` kaldırıldı.
5. **Audit log**: `apps/api/src/plugins/audit.ts` tüm write işlemlerini loglar. Bu plugin'i devre dışı bırakma.

## Primary Runtime

```bash
docker compose up -d
docker compose logs -f
docker compose down
docker compose up -d --build api worker  # kod değişikliğinden sonra
```

Adresler:
- Web: `http://172.28.204.133:4200`
- API: `http://172.28.204.133:3000`
- Swagger: `http://172.28.204.133:4200/docs`

## Konteyner Yapısı

```
api        → BCMS_BACKGROUND_SERVICES=none (HTTP only)
worker     → BCMS_BACKGROUND_SERVICES=notifications,ingest-worker,ingest-watcher,bxf-watcher
opta-watcher → Python, SMB → POST /api/v1/opta/sync
web        → nginx, Angular statik
postgres   → PostgreSQL 16
rabbitmq   → RabbitMQ 3.12
keycloak   → Auth
```

## Degraded Mod

OPTA dizini veya RabbitMQ geçici koptuğunda API çökmez:
- `/health` endpoint `status: "degraded"` ve `checks` objesi döner (HTTP 200)
- RabbitMQ `rabbitmq.isConnected()` ile sorgulanabilir
- OPTA `getOptaWatcherStatus()` ile sorgulanabilir
- DB koptuğunda operasyonel etki vardır

## Frontend

Admin navigasyonunda üç admin-only route:
- `Stüdyo Planı` → `/studio-plan`
- `Haftalık Shift` → `/weekly-shift`
- `Provys İçerik Kontrol` → `/provys-content-control`

Stüdyo Planı:
- `apps/web/src/app/features/studio-plan/studio-plan.component.ts`
- `studio_plans` + `studio_plan_slots` tabloları (schedules'tan ayrı)
- `GET/PUT /api/v1/studio-plans/:weekStart`, `GET/PUT /api/v1/studio-plans/catalog`
- `weekStart` Pazartesi tarihi olmak zorundadır

Ingest:
- Port board: `apps/web/src/app/features/ingest/ingest-port-board/ingest-port-board.component.ts`
- Parent: `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts`
- `ingest_plan_items` kalıcılık tablosu
- `recording_ports` port katalog tablosu (varsayılan 46 port)

## Prisma

Sürüm: 5.22.0

Generate sorunu çözümü:
```bash
rm -rf node_modules/.prisma node_modules/@prisma/client node_modules/prisma
npm install prisma@5.22.0 @prisma/client@5.22.0
npm run db:generate -w apps/api
```

Bu sorun CI'ya da yansıtıldı (ci.yml'de temiz reinstall adımı var).

DB enum isimleri: `booking_status`, `ingest_status`, `incident_severity` (Prisma `@@map` ile TypeScript enum'lara bağlı).

Local DB 2026-04-22'de 8 migration baseline edildi. `npm run db:migrate:prod -w apps/api` → "No pending migrations" dönmeli.

## OPTA Watcher

- Python konteyneri (`opta-watcher`), SMB'den dosya okur
- API çağrısı: `POST /api/v1/opta/sync` (Bearer token)
- Env: `BCMS_API_URL`, `BCMS_API_TOKEN`
- Doğrudan PostgreSQL erişimi yok; psycopg2 kaldırıldı

## Güvenlik

- `SKIP_AUTH=true` production'da yasak (`validateRuntimeEnv()` fırlatır)
- `xlsx` paketi kaldırıldı → `exceljs` (sadece `.xlsx` kabul edilir)
- Production'da required env: `DATABASE_URL`, `RABBITMQ_URL`, `CORS_ORIGIN`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_ADMIN_PASSWORD`, `INGEST_CALLBACK_SECRET`, `INGEST_ALLOWED_ROOTS`

## CI

`.github/workflows/ci.yml`:
1. npm ci + npm audit
2. Prisma cache temizliği + reinstall + generate
3. prisma migrate deploy
4. npm run test
5. npm run build (tüm repo)
6. API başlat (`BCMS_BACKGROUND_SERVICES=none`)
7. npm run smoke:api

## Lokal Ortam

- PostgreSQL: Docker konteyneri (bcms_postgres)
- RabbitMQ: Docker konteyneri (bcms_rabbitmq)
- Sudo şifresi: `ubuntu`

## Kaldırılan Dosyalar (Artık Yok)

- `ops/scripts/bcms-web-static-server.mjs` → nginx kullanılıyor
- `ops/scripts/bcms-db-bootstrap-empty.sh` → prisma migrate deploy
- `ops/scripts/bcms-install-cron-fallback.sh` → Docker Compose
- `ops/scripts/bcms-install-user-services.sh` → Docker Compose
- `ops/scripts/bcms-supervisor*.sh` → Docker Compose restart policy

## Önemli Dosya Konumları

```
apps/api/src/server.ts                    → graceful shutdown (SIGTERM)
apps/api/src/app.ts                       → buildApp, health endpoint (degraded mode)
apps/api/src/plugins/rabbitmq.ts          → RabbitMQClient, isConnected()
apps/api/src/plugins/audit.ts             → Prisma audit middleware
apps/api/src/modules/opta/opta.watcher.ts → OPTA dizin health + getOptaWatcherStatus()
apps/api/src/modules/opta/opta.sync.routes.ts → POST /api/v1/opta/sync
infra/docker/nginx.conf                   → Angular serve + API proxy + docs proxy
docker-compose.yml                        → api + worker ayrıştırması
```
