# BCMS Developer Guide

Bu dosya, projenin teknik mimarisini ve geliştirme süreçlerini kapsayan ana geliştirici rehberidir. Günlük operasyonlar ve bağlantı bilgileri için masaüstündeki diğer belgelere başvurun.

## Mimari Kurallar

1. **Servis izolasyonu**: API ve arka plan worker'ları ayrı Docker konteynerlerinde çalışır. `api` servisi yalnızca HTTP isteklerini karşılar (`BCMS_BACKGROUND_SERVICES=none`). Worker servisi RabbitMQ tüketimi ve dosya izlemeyi üstlenir.
2. **Graceful shutdown**: `SIGTERM` alındığında Fastify önce yeni istekleri reddeder, devam eden işlemleri bekler, DB ve RabbitMQ bağlantılarını kapatır. Zaman aşımı: 30 sn (API), 60 sn (worker).
3. **Degraded mod**: OPTA dizini veya RabbitMQ geçici olarak ulaşılamaz olduğunda API çökmez. `/health` endpoint `status: "degraded"` + HTTP **503** döner; temel DB işlemleri devam eder.
4. **usageScope kuralı**: `schedules.usage_scope` kolonu karar noktasıdır. `broadcast` = normal yayın, `live-plan` = canlı yayın planı. Metadata JSON filtresi kullanılmaz.
5. **Prisma üzerinden erişim**: `usage_scope` dahil tüm DB erişimi Prisma Client ile yapılır. Ham SQL köprüsü eklenmez.
6. **Audit log**: Tüm write işlemleri `apps/api/src/plugins/audit.ts` Prisma `$extends` ile `audit_logs` tablosuna yazılır. Kullanıcı bilgisi `onRequest`'te store oluşturulur, `preHandler`'da (JWT doğrulamasından sonra) doldurulur. `$use()` deprecated olduğu için kaldırılmıştır.
7. **Statik servis**: Angular build dosyaları `infra/docker/nginx.conf` üzerinden nginx ile sunulur. `bcms-web-static-server.mjs` kaldırılmıştır.
8. **Excel**: Yalnızca `exceljs` kullanılır; `xlsx` paketi güvenlik açığı nedeniyle kaldırılmıştır. Yalnızca `.xlsx` formatı kabul edilir.
9. **Angular production ortamı**: `apps/web/angular.json`'da production konfigürasyonunda `fileReplacements` tanımlı olmalıdır (`environment.ts` → `environment.prod.ts`). Bu olmadan Docker build `skipAuth: true` ile çalışır ("dev-admin" görünür, tüm API çağrıları 401 döner).
10. **Rate limiting**: API global olarak dakikada 300 istek sınırına tabidir (`@fastify/rate-limit`). `/health` ve ingest `/callback` muaftır. Aşımda HTTP 429 döner.
11. **Güvenlik header'ları**: nginx tüm yanıtlara `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy` ekler.
12. **Input validation**: Tüm API route'ları Zod ile doğrulama yapar. `request.query as {...}` cast'i kullanılmaz.

## Mimari

- Backend: Fastify + Prisma 5.22.0 + PostgreSQL + RabbitMQ
- Frontend: Angular (nginx ile statik serve)
- Auth: Keycloak (realm: bcms) — **grup tabanlı yetkilendirme** (`groups` JWT claim)
- Shared package: `packages/shared` — TypeScript tipleri + `PERMISSIONS` matrisi
- Build: Turborepo (`turbo.json`)
- Audit Log: Prisma middleware (`apps/api/src/plugins/audit.ts`)

## Konteyner Yapısı

| Servis | Görevi | `BCMS_BACKGROUND_SERVICES` |
|---|---|---|
| `api` | HTTP istekleri, Swagger, health | `none` |
| `worker` | RabbitMQ consumer, ingest, bxf, notifications | `notifications,ingest-worker,ingest-watcher,bxf-watcher` |
| `opta-watcher` | SMB → API HTTP sync (Python) | — |
| `web` | Angular statik dosyalar (nginx) | — |
| `postgres` | Veritabanı | — |
| `rabbitmq` | Mesaj kuyruğu | — |
| `keycloak` | Kimlik doğrulama | — |

## Dizinler

```text
apps/api              Fastify API, Prisma schema, background workers
apps/web              Angular web uygulamasi
packages/shared       Ortak TypeScript tipleri
ops/scripts           Aktif operasyon scriptleri (bcms-build, bcms-restart, bcms-status, bcms-logs)
infra/docker          Dockerfile'lar ve nginx.conf
infra/keycloak        Realm export
infra/postgres        DB init script
infra/rabbitmq        RabbitMQ config
infra/prometheus      Prometheus config
scripts               OPTA/SMB Python watcher
```

## Runtime

Tüm servisler Docker Compose ile yönetilmektedir. `systemd`, `tsx watch`, `ng serve` kullanılmaz.

```bash
# Başlat
docker compose up -d

# Loglar
docker compose logs -f
docker compose logs -f api worker

# Kod değişikliğinden sonra build + restart
docker compose up -d --build api worker

# Durdur
docker compose down
```

Adresler:
- Web: `http://172.28.204.133:4200`
- API: `http://172.28.204.133:3000`
- Swagger: `http://172.28.204.133:4200/docs` veya `http://172.28.204.133:3000/docs`

## Geliştirme Akışı

Kod değişikliğinden sonra:

```bash
npm run build -w packages/shared
npm run build -w apps/api
docker compose up -d --build api worker
```

Ya da:

```bash
npm run build
docker compose up -d --build api worker web
```

API smoke test:

```bash
npm run smoke:api
```

CI:

- GitHub Actions workflow: `.github/workflows/ci.yml`
- Adımlar: `npm ci`, `npm audit`, Prisma cache temizliği + generate, `prisma migrate deploy`, `npm run test`, full build, `npm run smoke:api`
- `BCMS_BACKGROUND_SERVICES=none` ile API başlatılır (worker CI'da çalışmaz)

## Health Endpoint

```bash
curl -fsS http://127.0.0.1:3000/health
```

Yanıt:
```json
{
  "status": "ok",
  "checks": { "database": "ok", "rabbitmq": "ok", "opta": "ok" },
  "timestamp": "..."
}
```

OPTA veya RabbitMQ geçici olarak koptuğunda `status: "degraded"` döner, HTTP **503** döner. Yalnızca veritabanı `degraded` ise operasyonel etki vardır.

## API

```text
apps/api/src
apps/api/dist   (build output)
```

Komutlar:

```bash
npm run build -w apps/api
npm run start -w apps/api
npm run db:generate -w apps/api
npm run db:migrate -w apps/api
npm run db:migrate:prod -w apps/api
npm run db:studio -w apps/api
```

## Canli Yayin Plani Veri Kapsami

Canlı yayın planı ekranından eklenen kayıtlar normal yayın akışı kaydı olarak kullanılmaz.

```text
schedules.usage_scope = 'live-plan'   → Raporlama ve Ingest
schedules.usage_scope = 'broadcast'  → Normal yayın (varsayılan)
```

- `schedules_usage_scope_check` DB constraint yalnızca bu iki değeri kabul eder.
- Eski `metadata.usageScope` geçiş alanı temizlenmiştir; filtreleme için kullanılmaz.

İlgili endpointler:

```text
GET  /api/v1/schedules?usage=live-plan
GET  /api/v1/schedules/ingest-candidates
GET  /api/v1/schedules/reports/live-plan
GET  /api/v1/schedules/reports/live-plan/export
POST /api/v1/incidents/report                          ← Sorun Bildir (SystemEng, Tekyon, Transmisyon)
POST /api/v1/ingest
GET  /api/v1/ingest/plan/report?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /api/v1/ingest/plan/report/export?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /api/v1/studio-plans/:weekStart
PUT  /api/v1/studio-plans/:weekStart
GET  /api/v1/studio-plans/reports/usage?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /api/v1/studio-plans/reports/usage/export?from=YYYY-MM-DD&to=YYYY-MM-DD
```

## Ortam Değişkenleri — Kritik Notlar

Production'da `KEYCLOAK_ADMIN` env'i zorunludur (Kullanıcı yönetimi Keycloak Admin API kullanır).
`docker-compose.yml` api servisinde `KEYCLOAK_ADMIN: ${KEYCLOAK_ADMIN}` tanımlıdır.

## Web

```text
apps/web/src          Kaynak kod
apps/web/dist/web/browser  Build output
```

Build:

```bash
npm run build -w apps/web
```

Web nginx üzerinden sunulur. Angular dev server (`ng serve`) sadece geliştirme debug'unda kullanılır.

**Önemli:** `angular.json` production konfigürasyonunda `fileReplacements` ile `environment.prod.ts` aktif olmalıdır. Web imajını rebuild etmeden değişiklik yansımaz:

```bash
docker compose up -d --build web
```

Tarayıcıda "dev-admin" kullanıcısı görünüyorsa → web imajı `environment.ts` (`skipAuth: true`) ile derlenmiş demektir. `--build web` ile yeniden derle.

### Grup Tabanlı Yetkilendirme (RBAC)

11 grup: `Tekyon`, `Transmisyon`, `Booking`, `YayınPlanlama`, `SystemEng`, `Ingest`, `Kurgu`, `MCR`, `PCR`, `Ses`, `StudyoSefi`

`SystemEng` her zaman tüm ekranlara tam erişimlidir.

| Sekme / Özellik | Erişim |
|---|---|
| Yayın Planı listesi | Tüm authenticated |
| Yeni Ekle | SystemEng, Booking, YayınPlanlama |
| Düzenle | SystemEng, Tekyon, Transmisyon, Booking, YayınPlanlama |
| Teknik Detay | SystemEng, Transmisyon, Booking |
| Çoğaltma | SystemEng, Tekyon, Transmisyon, Booking |
| Silme | SystemEng, Tekyon, Transmisyon, Booking, YayınPlanlama |
| **Sorun Bildir** | **SystemEng, Tekyon, Transmisyon** |
| Stüdyo Planı görüntüle | Tüm authenticated |
| Stüdyo Planı düzenle | SystemEng, StudyoSefi |
| Rezervasyonlar | SystemEng |
| Ingest | SystemEng, Ingest |
| MCR | SystemEng, MCR |
| Kullanıcılar | SystemEng |
| Ayarlar | SystemEng |
| Provys, Kanallar, Monitoring | SystemEng |

Yetki matrisi: `packages/shared/src/types/rbac.ts` → `PERMISSIONS` sabiti.
API: `app.requireGroup(...groups)` — boş array = tüm authenticated, doluysa grup üyeliği zorunlu.
Frontend: `tokenParsed.groups` + `computed()` sinyaller.

### Stüdyo Planı

- StudyoSefi ve SystemEng tam yetkili; diğerleri yalnızca liste görünümü.
- 5 stüdyo kolonu: Stüdyo 1-4 + beIN Gurme.
- Program/renk backend katalogdan: `studio_plan_programs`, `studio_plan_colors`.
- Veri: `studio_plans` + `studio_plan_slots` (schedules'tan ayrı).
- Endpoint: `GET/PUT /api/v1/studio-plans/:weekStart`, `GET/PUT /api/v1/studio-plans/catalog`.
- `weekStart` yalnızca Pazartesi tarihi kabul edilir.
- Kullanım raporu: `GET /reports/usage` (JSON) ve `GET /reports/usage/export` (xlsx). Her slot = 30 dakika.
- Raporlama sayfasında "Stüdyo Kullanım Raporu" seçeneği → tarih aralığı filtresi → Excel/PDF export.
- `/studio-plan/report` bağımsız route'u kaldırılmıştır; rapor artık yalnızca `/schedules/reporting` üzerinden erişilir.

### Raporlama (`/schedules/reporting`)

Bağımsız navigasyon öğesi — üç rapor tipi desteklenir:

| Rapor Tipi | Filtre | Excel | PDF |
|---|---|---|---|
| `live-plan` | Lig/hafta veya tarih aralığı | ✓ | ✓ |
| `studio-usage` | Tarih aralığı | ✓ (TOPLAM satırı) | ✓ (TOPLAM satırı) |
| `ingest` | Tarih aralığı | ✓ (TOPLAM satırı) | ✓ (TOPLAM satırı) |

- Excel/PDF butonları yalnızca seçili raporda veri varken aktif olur.
- `currentReport()` metodu her export çağrısında doğru `exportEndpoint`'i döner (computed signal yerine, sinyal bağımlılığı olmayan computed'ın önbellek sorununu önler).

### Ingest Planlama

- `Ingest Planlama`: Canlı yayın planı ve Stüdyo Planı kayıtlarını birleştiren tablo; port ataması burada yapılır.
- `Port Görünümü`: Port bazlı operasyonel pano — bağımsız tarih seçici, 5 satır, katalog sırası, tam ekran, zoom, print. Lazy render (`<ng-template matTabContent>`).
- Kayıt portları: `recording_ports` backend tablosundan gelir (varsayılan 1-44 + Metus1/Metus2 = 46 port).
- Port atama kalıcılığı: `ingest_plan_items.recording_port`.
- Çakışma kontrolü backend tarafında reddedilir.
- **Saat düzenleme**: Tüm satır tipleri (live-plan, studio-plan, ingest-plan) için 5 dk adımlı time input. Kaydedilen `plannedStartMinute`/`plannedEndMinute` kaynak sistemin saatini geçersiz kılar.
- **Satır silme/temizleme**: `DELETE /api/v1/ingest/plan/:sourceKey` — ingest-plan satırı tamamen silinir; live/studio-plan satırında sadece port ve not temizlenir, satır kaynak veriden gelmeye devam eder.
- **Burst polling**: Kayıt yapılınca veya Port Görünümü sekmesine geçince 6×10 sn sorgu (1 dk), değişiklik yoksa durur.
- Rapor endpointleri: `GET /api/v1/ingest/plan/report` (JSON) ve `/plan/report/export` (xlsx).

## Yerel Altyapı (Docker)

| Servis | Port | Erişim | Konteyner |
|---|---|---|---|
| API | **127.0.0.1:3000** | Sadece localhost | bcms_api |
| PostgreSQL | **5433** (host) / 5432 (container) | Tüm arayüzler | bcms_postgres |
| RabbitMQ AMQP | **5673** (host) / 5672 (container) | Tüm arayüzler | bcms_rabbitmq |
| RabbitMQ UI | **127.0.0.1:15673** | Sadece localhost | bcms_rabbitmq |
| Keycloak | 8080 | Tüm arayüzler | bcms_keycloak |
| Prometheus | **127.0.0.1:9090** | Sadece localhost | bcms_prometheus |
| Grafana | 3001 | Tüm arayüzler | bcms_grafana |

> **Not:** API portu `127.0.0.1:3000` olarak bağlanmıştır — doğrudan LAN erişimine kapalıdır. Web uygulaması `/api` proxy üzerinden erişir; dış erişim için nginx veya SSH tüneli kullanılmalıdır.

## Prisma

- Sürüm: 5.22.0
- Generate sorunu çözümü: `rm -rf node_modules/.prisma node_modules/@prisma/client node_modules/prisma && npm install prisma@5.22.0 @prisma/client@5.22.0 && npm run db:generate -w apps/api`
- DB enum isimleri: `booking_status`, `ingest_status`, `incident_severity` (Prisma `@@map` ile bağlı)
- Local DB 2026-04-22'de 8 migration baseline edildi
- 2026-04-25: `20260425000000_add_ingest_job_updated_at` — `ingest_jobs.updated_at` kolonu eklendi
- 2026-04-26: 10 adet tekrar eden index kaldırıldı (`audit_logs_entity`, `audit_logs_ts`, `audit_logs_user`, `incidents_resolved_sev`, `incidents_schedule_sev`, `ingest_jobs_status`, `matches_league_date`, `schedules_channel_time`, `schedules_status`, `signal_telemetry_channel_time`)

## Ortam Değişkenleri

Ana dosya: `.env`

```bash
NODE_ENV=production
DATABASE_URL=postgresql://...
RABBITMQ_URL=amqp://...
KEYCLOAK_CLIENT_ID=bcms-api
KEYCLOAK_ALLOWED_ISSUERS=http://<LAN_IP>:8080/realms/bcms,http://localhost:8080/realms/bcms
KC_HOSTNAME=<LAN_IP>         # Keycloak token issuer'ı için sabit IP
KC_HOSTNAME_PORT=8080
INGEST_CALLBACK_SECRET=...
INGEST_ALLOWED_ROOTS=/opta,/app/tmp/watch
BCMS_BACKGROUND_SERVICES=none       # docker-compose'da API için sabit
OPTA_WATCHER_API_TOKEN=...          # POST /opta/sync Bearer token (API=OPTA_SYNC_SECRET)
BXF_WATCH_DIR=/app/tmp/bxf
CORS_ORIGIN=http://<LAN_IP>:4200,http://localhost:4200
```

Production'da RabbitMQ bağlantısı kurulamazsa API fail-fast davranır. `RABBITMQ_OPTIONAL=true` yalnızca lokal/geliştirme için kullanılabilir.

### LAN / Ağ Erişimi

Farklı bir bilgisayardan erişimde iki ayar zorunludur:

1. **Keycloak redirect_uri**: `infra/keycloak/realm-export.json`'da `bcms-web` client'ının `redirectUris` ve `webOrigins` listesine `http://<LAN_IP>:4200/*` eklenmeli. Çalışan Keycloak'a Keycloak Admin REST API ile de uygulanabilir (restart gerekmez).
2. **Token issuer**: `KC_HOSTNAME_STRICT=false` ile Keycloak token `iss` değerini isteği yapan IP'ye göre yazar (localhost ↔ LAN farklı issuer). API `KEYCLOAK_ALLOWED_ISSUERS` env değişkeni ile birden fazla issuer kabul eder. `.env`'de hem LAN IP hem `localhost` issueri tanımlanmalıdır.

## OPTA

OPTA SMB watcher ayrı Python konteyneri (`opta-watcher`) olarak çalışır, verilerini `POST /api/v1/opta/sync` endpoint'ine HTTP ile gönderir. Doğrudan PostgreSQL erişimi yoktur.

`POST /api/v1/opta/sync` endpoint'i **Bearer token** kimlik doğrulaması gerektirir. Token `OPTA_SYNC_SECRET` env değişkeninden okunur (`docker-compose.yml`'de `OPTA_WATCHER_API_TOKEN` değişkenine eşlenir, `.env`'de tanımlıdır).

### Watcher davranışı (`scripts/opta_smb_watcher.py`)

- `MTIME_SETTLE_SEC = 5`: Dosyanın son değişiminden bu kadar saniye geçmeden işlenmez — SMB üzerinden yarım yazılmış XML'i okumayı önler.
- `BATCH_SIZE = 100`: Büyük XML dosyalarındaki maç listesi 100'er maçlık parçalara bölünür, her parça ayrı POST isteği ile gönderilir — Fastify payload limitini (varsayılan 1 MB) aşmayı önler.
- Tarama aralığı: `OPTA_POLL_INTERVAL` (varsayılan 3600 sn).

### Sync endpoint davranışı (`apps/api/src/modules/opta/opta.sync.routes.ts`)

- Gelen `matches` dizisindeki benzersiz ligler önce toplu upsert edilir.
- Mevcut maçlar tek sorguda çekilir; insert/update/unchanged listeleri ayrıştırılır.
- Tüm insertlar ve updatelar tek bir Prisma `$transaction` içinde yazılır (N+1 sorgu yok).

### docker-compose

`opta-watcher` servisi `network_mode: host` ile çalışır; `BCMS_API_URL=http://localhost:3000/api/v1`.

## Servis Kontrolü

```bash
docker compose ps
docker compose logs -f
docker compose logs -f api
docker compose logs -f worker
docker compose restart api
docker compose up -d --build api worker
```

Doğrulama:

```bash
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:4200/
curl -fsS http://127.0.0.1:4200/api/v1/channels
```

## Operasyon Belgeleri

- `/home/ubuntu/Desktop/BCMS_BAGLANTI_BILGILERI.txt` — bağlantı ve kimlik bilgileri
- `ops/README.md` — Docker Compose operasyon özeti
- `ops/NOTES_FOR_CODEX.md` — gelecekteki oturumlar için teknik not
