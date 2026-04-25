# Notes For Future Codex Sessions

## Mimari Kurallar (Değiştirilmez)

1. **API/Worker ayrıştırması**: `api` servisi `BCMS_BACKGROUND_SERVICES=none` ile çalışır. Worker servisi `notifications,ingest-worker,ingest-watcher,bxf-watcher` çalıştırır. OPTA Python watcher ayrı konteyner. Bu ayrım bozulmamalı.
2. **Graceful shutdown**: `server.ts`'de SIGTERM/SIGINT → `app.close()` → 30 sn timeout. Worker için 60 sn. `--force` veya anında kill önerilmez.
3. **usageScope kanonik**: `schedules.usage_scope` DB kolonudur. Metadata JSON filtresi yoktur. Ham SQL köprüsü eklenmez.
4. **Nginx static serve**: Angular dosyaları `infra/docker/web.Dockerfile` → nginx:alpine ile sunulur. `bcms-web-static-server.mjs` kaldırıldı.
5. **Audit log**: `apps/api/src/plugins/audit.ts` tüm write işlemlerini loglar. Bu plugin'i devre dışı bırakma.
6. **Angular production environment**: `apps/web/angular.json` production konfigürasyonunda `fileReplacements` ile `environment.ts` → `environment.prod.ts` değişimi tanımlı olmalı. Aksi hâlde Docker build `skipAuth: true` ile çalışır ("dev-admin" görünür, tüm API çağrıları 401 döner). Web imajı rebuild: `docker compose up -d --build web`.

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
- `/health` endpoint `status: "degraded"` ve `checks` objesi döner (HTTP **503**)
- RabbitMQ `rabbitmq.isConnected()` ile sorgulanabilir
- OPTA `getOptaWatcherStatus()` ile sorgulanabilir
- DB koptuğunda operasyonel etki vardır

## Frontend

Admin navigasyonunda:
- `Yayın Planı` (grup) → Canlı Yayın Plan Listesi `/schedules` + Günlük Yayın Raporu `/schedules/daily-report`
- `Rezervasyonlar` → `/bookings`
- `Raporlama` → `/schedules/reporting` (**bağımsız** öğe — Yayın Planı grubunun altında değil)
- `Stüdyo Planı` → `/studio-plan` (tek öğe, artık grup değil; `/studio-plan/report` route'u kaldırıldı)
- `Haftalık Shift` → `/weekly-shift`
- `Provys İçerik Kontrol` → `/provys-content-control`

**KRİTİK nav kuralı:** `Raporlama` bağımsız nav öğesidir. `Yayın Planı` grubuna veya `Stüdyo Planı` grubuna eklenmez. `Stüdyo Planı`'nın alt öğesi yoktur.

Stüdyo Planı:
- `apps/web/src/app/features/studio-plan/studio-plan.component.ts`
- `studio_plans` + `studio_plan_slots` tabloları (schedules'tan ayrı)
- `GET/PUT /api/v1/studio-plans/:weekStart`, `GET/PUT /api/v1/studio-plans/catalog`
- `weekStart` Pazartesi tarihi olmak zorundadır

Raporlama Sayfası (`/schedules/reporting`):
- `apps/web/src/app/features/schedules/reporting/schedule-reporting.component.ts`
- Rapor tipleri: `live-plan`, `studio-usage`, `ingest` (dropdown seçimi)
- Tarih alanları: `TrDateAdapter` ile dd.MM.yyyy formatı hem yazma hem takvim seçimi destekler
- Excel/PDF butonları veri varken aktif, yokken pasif
- **KRİTİK:** `exportExcel()` içinde `this.selectedReport()` computed KULLANILMAZ — `currentReport()` metodunu kullan. Angular computed, sinyal olmayan `selectedReportId` property'sini takip etmez; ilk değer olan `live-plan`'ı döner ve önbellekte kalır.

Stüdyo Kullanım Raporu (API):
- `GET /api/v1/studio-plans/reports/usage?from=YYYY-MM-DD&to=YYYY-MM-DD` → JSON
- `GET /api/v1/studio-plans/reports/usage/export?from=YYYY-MM-DD&to=YYYY-MM-DD` → xlsx (ExcelJS, TOPLAM satırı)
- Her slot 30 dakika sayılır; program bazında toplanır
- `apps/api/src/modules/studio-plans/studio-plan.routes.ts` içinde `queryStudioUsage()` helper

Ingest Raporu (API):
- `GET /api/v1/ingest/plan/report?from=YYYY-MM-DD&to=YYYY-MM-DD` → JSON (IngestPlanItem listesi)
- `GET /api/v1/ingest/plan/report/export?from=YYYY-MM-DD&to=YYYY-MM-DD` → xlsx (TOPLAM satırı)
- Kolonlar: Tarih, Kaynak Tipi, İçerik (describeSourceKey), Port, Başlangıç, Bitiş, Süre, Durum (TR), Not, Güncelleyen
- `apps/api/src/modules/ingest/ingest.routes.ts` içinde tanımlı

Ingest Port Board:
- Port board: `apps/web/src/app/features/ingest/ingest-port-board/ingest-port-board.component.ts`
- Parent: `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts`
- `ingest_plan_items` kalıcılık tablosu
- `recording_ports` port katalog tablosu (varsayılan 46 port)
- Port board tarih seçici: `portBoardDate` signal, `loadPortBoardData()`, planlama tabından bağımsız
- Port board lazy render: `<ng-template matTabContent>` (46 CDK kolon tab aktif olana kadar render edilmez)
- Burst polling: `startBurstPoll()` — kayıt/sekme değişince 6×10 sn, değişiklik yoksa durur
- Saat düzenleme: tüm satır tipleri için (live/studio/ingest-plan), 5 dk adımlı `input[type=time step=300]`
  - `onStartTimeChange/onEndTimeChange` → `Math.round(.../ 5) * 5` → `savePlanRow`
  - `planningRows` ve `portBoardAllRows`: `planItem?.plannedStartMinute ?? srcMinute` (kayıtlı saat kaynağı geçer)
  - API şema limiti: `max(48 * 60)` (sabaha karşı shift için)
- Satır silme: `DELETE /api/v1/ingest/plan/:sourceKey` — tüm sourceType için izin verilir
  - ingest-plan → satır tamamen silinir; live/studio-plan → port+not temizlenir, satır görünmeye devam eder
- savePlanRow optimizasyonu: port + not + saat değişmemişse API çağrısı atlanır

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

**Migration listesi (güncel):**
- `20260423000000_studio_plans` … `20260423005000_recording_ports_1_44_metus` (stüdyo + ingest)
- `20260425000000_add_ingest_job_updated_at` — `ingest_jobs.updated_at TIMESTAMP NOT NULL DEFAULT NOW()`

**Önemli:** `migrate dev` container içinde shadow DB gerektirdiğinden çalışmaz. Yeni migration için:
1. Migration SQL dosyasını `prisma/migrations/<tarih_isim>/migration.sql` olarak oluştur
2. `docker compose exec postgres psql -U bcms_user -d bcms -f <sql>` ile uygula
3. `_prisma_migrations` tablosuna `INSERT` ile kaydet
4. API container rebuild et: `docker compose up -d --build api`

## OPTA Watcher

- Python konteyneri (`opta-watcher`), SMB'den dosya okur
- API çağrısı: `POST /api/v1/opta/sync` (Bearer token)
- Env: `BCMS_API_URL=http://localhost:3000/api/v1`, `BCMS_API_TOKEN`
- Doğrudan PostgreSQL erişimi yok; psycopg2 kaldırıldı
- `network_mode: host` — bridge DNS sorunu olmadan API'ye localhost üzerinden erişir
- `MTIME_SETTLE_SEC=5` — SMB yarım yazma koruması; dosya son mtime'dan 5 sn geçmeden işlenmez
- `BATCH_SIZE=100` — büyük payload'ları 100'er maçlık chunk'lara böler; Fastify 1 MB limitini önler

### Sync Endpoint (`opta.sync.routes.ts`) — 2026-04-25

N+1 sorgu problemi giderildi. Yeni akış:
1. Gelen `matches` dizisinden benzersiz ligler çıkarılır, `Promise.all` ile toplu upsert
2. Tüm `matchUid`'ler tek `findMany` ile çekilir → insert/update/unchanged ayrıştırılır
3. Tüm yazma tek `$transaction([...creates, ...updates])` içinde

## Keycloak / Auth

- Keycloak oturumları **in-memory** tutulur (disk kalıcılığı yok). Docker restart sonrası tüm oturumlar geçersiz olur.
- Tarayıcı eski token'ı kullanmaya devam ederse → Ctrl+Shift+R (hard refresh) + yeniden giriş.
- Test kullanıcısı: `admin` / `admin123`

## LAN Erişimi ve Çoklu Issuer Desteği (2026-04-25)

**Sorun:** `KC_HOSTNAME_STRICT=false` ile Keycloak token `iss` değerini isteği yapan IP'ye göre yazar.
- `localhost:4200` → `iss: http://localhost:8080/realms/bcms`
- `172.28.204.133:4200` → `iss: http://172.28.204.133:8080/realms/bcms`

**Çözüm:** `auth.ts` artık `KEYCLOAK_ALLOWED_ISSUERS` env değişkenini okur ve hepsini kabul eder:
```
KEYCLOAK_ALLOWED_ISSUERS=http://172.28.204.133:8080/realms/bcms,http://localhost:8080/realms/bcms
```

**Redirect URI:** `infra/keycloak/realm-export.json` ve Keycloak Admin API ile `bcms-web` client'ına `http://172.28.204.133:4200/*` eklendi.

**docker-compose.yml:** `KC_HOSTNAME` ve `KC_HOSTNAME_PORT` artık `.env`'den env var olarak okunuyor (hardcoded değil):
```yaml
KC_HOSTNAME: ${KC_HOSTNAME:-172.28.204.133}
KC_HOSTNAME_PORT: ${KC_HOSTNAME_PORT:-8080}
```

**auth.ts değişikliği:** `issuer` tek string yerine `allowedIssuers` array — `allowedIssuers.includes(claims.iss ?? '')`

## Güvenlik

- `SKIP_AUTH=true` production'da yasak (`validateRuntimeEnv()` fırlatır)
- `xlsx` paketi kaldırıldı → `exceljs` (sadece `.xlsx` kabul edilir)
- Production'da required env: `DATABASE_URL`, `RABBITMQ_URL`, `CORS_ORIGIN`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_ADMIN_PASSWORD`, `INGEST_CALLBACK_SECRET`, `INGEST_ALLOWED_ROOTS`

### Dockerfile HEALTHCHECK (2026-04-25)
- `infra/docker/api.Dockerfile` production stage'e HEALTHCHECK eklendi
- `wget --spider http://localhost:3000/health` — 30s interval, 5s timeout, 15s start-period, 3 retry
- Docker artık sessiz API çökmelerini detect eder; `docker ps` sütununda `(healthy)` görünür
- `docker inspect bcms_api --format='{{.State.Health.Status}}'` ile durum sorgulanabilir

### Signal Simulate Endpoint (2026-04-25)
- `/api/v1/signals/simulate` production'da koşulsuz `403 Forbidden` döner
- `ENABLE_SIGNAL_SIMULATE` env bypass'ı kaldırıldı — production'da açılamaz

### Port Binding Güvenliği (2026-04-25)
- RabbitMQ management UI: `15673:15672` → `127.0.0.1:15673:15672` (LAN kapalı)
- Prometheus: `9090:9090` → `127.0.0.1:9090:9090` (LAN kapalı)
- Bu servislere sadece sunucu üzerinden erişilebilir (SSH tüneli ile uzaktan görülebilir)

### Rate Limiting (2026-04-25)
- `@fastify/rate-limit` global: 300 istek/dk, HTTP 429 + kalan süre mesajı
- Muaf: `/health` ve ingest `/callback` — `config: { rateLimit: false }`
- keyGenerator: `X-Real-IP` header → nginx proxy arkasında gerçek IP tanınır
- `apps/api/src/app.ts`'de `buildApp()` içinde CORS'tan hemen sonra register edilir

### nginx Güvenlik Header'ları (2026-04-25)
- `infra/docker/nginx.conf` server bloğuna eklendi:
  `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `X-XSS-Protection`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `X-Robots-Tag`
- Web imajı rebuild gerekir: `docker compose up -d --build web`

### Input Validation Kuralı (2026-04-25)
- `audit.routes.ts`: `auditQuerySchema` (Zod) eklendi — `request.query as {...}` kaldırıldı
  - `from`/`to`: `z.string().datetime({ offset: true })` — geçersiz tarih 400 döner
  - `entityId`: `z.coerce.number().int().positive()` — NaN riski giderildi
  - `user contains`: `mode: 'insensitive'` eklendi
  - `pageSize`: max 500 ile sınırlandırıldı
- Kural: Tüm yeni route'larda `request.query as {...}` cast KULLANILMAZ, Zod schema yazılır

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
apps/api/src/server.ts                           → graceful shutdown (SIGTERM)
apps/api/src/app.ts                              → buildApp, health, rate-limit, CORS, helmet
apps/api/src/plugins/auth.ts                     → JWT doğrulama, allowedIssuers (çoklu issuer)
apps/api/src/plugins/rabbitmq.ts                 → RabbitMQClient, isConnected()
apps/api/src/plugins/audit.ts                    → Prisma audit middleware
apps/api/src/modules/audit/audit.routes.ts       → auditQuerySchema (Zod) ile validate
apps/api/src/modules/opta/opta.watcher.ts        → OPTA dizin health + getOptaWatcherStatus()
apps/api/src/modules/opta/opta.sync.routes.ts    → POST /api/v1/opta/sync
apps/api/src/modules/ingest/ingest.routes.ts     → GET /plan/report + /plan/report/export + DELETE /plan/:key
apps/api/src/modules/studio-plans/studio-plan.routes.ts → GET /reports/usage + /reports/usage/export
apps/api/prisma/schema.prisma                    → IngestJob.updatedAt eklendi
apps/web/src/app/app.component.ts                → navItems (Raporlama bağımsız, Stüdyo Planı tek öğe)
apps/web/src/app/app.routes.ts                   → route tanımları (studio-plan/report yok)
apps/web/src/app/features/schedules/reporting/schedule-reporting.component.ts → Raporlama sayfası
apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts → port board, saat düzenleme, silme
apps/web/angular.json                            → fileReplacements (environment.prod.ts aktif edilmeli!)
apps/web/src/environments/environment.ts             → skipAuth: true  (SADECE ng serve için)
apps/web/src/environments/environment.prod.ts        → skipAuth: false (Docker build için)
infra/docker/nginx.conf                          → Angular serve + API proxy + 6 güvenlik header
infra/keycloak/realm-export.json                 → bcms-web client: LAN IP redirect_uri eklendi
docker-compose.yml                               → api+worker ayrıştırması; KC_HOSTNAME env var'dan
```
