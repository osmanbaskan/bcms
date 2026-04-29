# BCMS Developer Guide

Bu dosya, projenin teknik mimarisini ve geliştirme süreçlerini kapsayan ana geliştirici rehberidir. Günlük operasyonlar ve bağlantı bilgileri için masaüstündeki diğer belgelere başvurun.

> **Son güncelleme**: 2026-04-29 — Ekip İş Takip ve Haftalık Shift modülleri eklendi. Worker health check sorunu not edildi.

## Mimari Kurallar

1. **Servis izolasyonu**: API ve arka plan worker'ları ayrı Docker konteynerlerinde çalışır. `api` servisi yalnızca HTTP isteklerini karşılar (`BCMS_BACKGROUND_SERVICES=none`). Worker servisi RabbitMQ tüketimi ve dosya izlemeyi üstlenir.
2. **Graceful shutdown**: `SIGTERM` alındığında Fastify önce yeni istekleri reddeder, devam eden işlemleri bekler, DB ve RabbitMQ bağlantılarını kapatır. Zaman aşımı: 30 sn (API), 60 sn (worker).
3. **Degraded mod**: OPTA dizini veya RabbitMQ geçici olarak ulaşılamaz olduğunda API çökmez. `/health` endpoint `status: "degraded"` + HTTP **503** döner; temel DB işlemleri devam eder.
4. **usageScope kuralı**: `schedules.usage_scope` kolonu karar noktasıdır. `broadcast` = normal yayın, `live-plan` = canlı yayın planı. Metadata JSON filtresi kullanılmaz.
5. **Prisma üzerinden erişim**: `usage_scope` dahil tüm DB erişimi Prisma Client ile yapılır. Ham SQL köprüsü eklenmez.
6. **Audit log**: Tüm write işlemleri `apps/api/src/plugins/audit.ts` Prisma `$extends` ile `audit_logs` tablosuna yazılır.
7. **Statik servis**: Angular build dosyaları `infra/docker/nginx.conf` üzerinden nginx ile sunulur.
8. **Excel**: Yalnızca `exceljs` kullanılır; `xlsx` paketi güvenlik açığı nedeniyle kaldırılmıştır.
9. **Angular production ortamı**: `apps/web/angular.json`'da production konfigürasyonunda `fileReplacements` tanımlı olmalıdır.
10. **Rate limiting**: API global olarak dakikada 300 istek sınırına tabidir. `/health` ve ingest `/callback` muaftır.
11. **Güvenlik header'ları**: nginx tüm yanıtlara 6 güvenlik header'ı ekler.
12. **Input validation**: Tüm API route'ları Zod ile doğrulama yapar.

## Mimari

- Backend: Fastify + Prisma 5.22.0 + PostgreSQL + RabbitMQ
- Frontend: Angular 21.2.8 (nginx ile statik serve)
- Auth: Keycloak (realm: bcms) — **grup tabanlı yetkilendirme** (`groups` JWT claim)
- Shared package: `packages/shared` — TypeScript tipleri + `PERMISSIONS` matrisi
- Build: Turborepo (`turbo.json`)
- Audit Log: Prisma `$extends` (`apps/api/src/plugins/audit.ts`)

## Konteyner Yapısı

| Servis | Konteyner | Görevi | Health |
|---|---|---|---|
| `api` | bcms_api | HTTP istekleri, Swagger, health | `healthy` |
| `worker` | bcms_worker | RabbitMQ consumer, ingest, bxf, notifications | **⚠️ `unhealthy`** — HTTP probe çalışmıyor |
| `opta-watcher` | bcms_opta_watcher | SMB → API HTTP sync (Python) | — |
| `web` | bcms_web | Angular statik dosyalar (nginx) | `healthy` |
| `postgres` | bcms_postgres | PostgreSQL 16 | — |
| `rabbitmq` | bcms_rabbitmq | Mesaj kuyruğu | — |
| `keycloak` | bcms_keycloak | Kimlik doğrulama | — |
| `prometheus` | bcms_prometheus | Metrikler | — |
| `grafana` | bcms_grafana | Dashboard | — |
| `mailhog` | bcms_mailhog | SMTP (dev) | — |

> **Worker Health (2026-04-29)**: `bcms_worker` health check `curl http://localhost:3000/health` kullanıyor ama worker HTTP sunucusu çalıştırmaz. Fonksiyonel sorun değildir — worker normal çalışır. Docker Compose'ta worker health check kaldırılmalı veya RabbitMQ bağlantı kontrolüne çevrilmeli.

## Dizinler

```text
apps/api              Fastify API, Prisma schema, background workers
apps/web              Angular web uygulamasi
packages/shared       Ortak TypeScript tipleri
ops/scripts           Aktif operasyon scriptleri
infra/docker          Dockerfile'lar ve nginx.conf
infra/keycloak        Realm export
infra/postgres        DB init script
infra/rabbitmq        RabbitMQ config
infra/prometheus      Prometheus config
infra/grafana         Grafana dashboards
scripts               OPTA/SMB Python watcher
```

## Runtime

Tüm servisler Docker Compose ile yönetilmektedir.

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

OPTA veya RabbitMQ geçici olarak koptuğunda `status: "degraded"` döner, HTTP **503** döner.

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

```text
schedules.usage_scope = 'live-plan'   → Raporlama ve Ingest
schedules.usage_scope = 'broadcast'  → Normal yayın (varsayılan)
```

- `schedules_usage_scope_check` DB constraint yalnızca bu iki değeri kabul eder.

İlgili endpointler:

```text
GET  /api/v1/schedules?usage=live-plan
GET  /api/v1/schedules/ingest-candidates
GET  /api/v1/schedules/reports/live-plan
GET  /api/v1/schedules/reports/live-plan/export
POST /api/v1/incidents/report
POST /api/v1/ingest
GET  /api/v1/ingest/plan/report?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /api/v1/ingest/plan/report/export?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /api/v1/studio-plans/:weekStart
PUT  /api/v1/studio-plans/:weekStart
GET  /api/v1/studio-plans/reports/usage?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /api/v1/studio-plans/reports/usage/export?from=YYYY-MM-DD&to=YYYY-MM-DD
GET  /api/v1/bookings
POST /api/v1/bookings
PATCH /api/v1/bookings/:id
DELETE /api/v1/bookings/:id
GET  /api/v1/weekly-shifts
PUT  /api/v1/weekly-shifts/:weekStart
```

## Ortam Değişkenleri — Kritik Notlar

Production'da `KEYCLOAK_ADMIN` env'i zorunludur.
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

**Önemli:** `angular.json` production konfigürasyonunda `fileReplacements` ile `environment.prod.ts` aktif olmalıdır.

```bash
docker compose up -d --build web
```

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
| **Ekip İş Takip** | **SystemEng** |
| **Haftalık Shift** | **SystemEng** |
| Rezervasyonlar | SystemEng |
| Ingest | SystemEng, Ingest |
| MCR | SystemEng, MCR |
| Kullanıcılar | SystemEng |
| Ayarlar | SystemEng |
| Provys, Kanallar, Monitoring | SystemEng |

Yetki matrisi: `packages/shared/src/types/rbac.ts` → `PERMISSIONS` sabiti.
API: `app.requireGroup(...groups)`
Frontend: `tokenParsed.groups` + `computed()` sinyaller.

### Ekip İş Takip (Booking / Work Tracking) — 2026-04-29

- Konum: `Canlı Yayın Plan Listesi → Ekip İş Takip` sekmesi
- Modül: `apps/web/src/app/features/bookings/`
- Backend: `apps/api/src/modules/bookings/`
- Tablo: `bookings`
- Liste görünümü (mat-table): İş Başlığı, Grup, Oluşturan, Durum, Tarih, Sorumlu, Aksiyonlar
- Durumlar: `PENDING` (Açık), `APPROVED` (Tamamlandı), `REJECTED` (Reddedildi), `CANCELLED` (İptal)
- Sıralama: PENDING işler yukarıda, sonra `startDate`'e göre
- Dialog: `BookingTaskDialogComponent` — İş Başlığı, Grup, Başlama/Tamamlanma Tarihi, Sorumlu, Durum, Detaylar, Rapor
- API: `GET/POST/PATCH/DELETE /api/v1/bookings`

### Haftalık Shift (Weekly Shift) — 2026-04-29

- Konum: `Haftalık Shift` navigasyon öğesi
- Modül: `apps/web/src/app/features/weekly-shift/`
- Backend: `apps/api/src/modules/weekly-shifts/`
- Tablolar: `weekly_shifts`, `weekly_shift_assignments`
- Haftalık tablo (Pzt-Paz), her hücrede vardiya tipi ve saat
- Vardiya tipleri: `OFF_DAY`, `HOME`, `OUTSIDE`, `NIGHT`, `SIC_CER`, `HOLIDAY`, `ANNUAL`
- Excel/PDF export: Renkli hücreler, zebra striping
- Bitiş saatleri: `06:15, 13:15, 15:00, 16:45, 20:00, 22:00, 23:45, Y.SONU`
- API: `GET /api/v1/weekly-shifts`, `PUT /api/v1/weekly-shifts/:weekStart`

### Stüdyo Planı

- StudyoSefi ve SystemEng tam yetkili; diğerleri yalnızca liste görünümü.
- **Liste görünümünde geçmiş günler gizlenir**.
- 5 stüdyo kolonu: Stüdyo 1-4 + beIN Gurme.
- Program/renk backend katalogdan.
- Veri: `studio_plans` + `studio_plan_slots` (schedules'tan ayrı).
- `weekStart` yalnızca Pazartesi tarihi kabul eder.

### Raporlama (`/schedules/reporting`)

| Rapor Tipi | Filtre | Excel | PDF |
|---|---|---|---|
| `live-plan` | Lig/hafta veya tarih aralığı | ✓ | ✓ |
| `studio-usage` | Tarih aralığı | ✓ (TOPLAM satırı) | ✓ (TOPLAM satırı) |
| `ingest` | Tarih aralığı | ✓ (TOPLAM satırı) | ✓ (TOPLAM satırı) |

### Ingest Planlama

- `Ingest Planlama`: Canlı yayın planı ve Stüdyo Planı kayıtlarını birleştiren tablo.
- `Port Görünümü`: Port bazlı operasyonel pano.
- Kayıt portları: `recording_ports` (varsayılan 46 port).
- Port atama kalıcılığı: `ingest_plan_items.recording_port`.
- Saat düzenleme: 5 dk adımlı.
- Burst polling: 6×10 sn.

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
| Mailhog UI | 8025 | Tüm arayüzler | bcms_mailhog |

## Prisma

- Sürüm: 5.22.0
- Generate sorunu çözümü: `rm -rf node_modules/.prisma node_modules/@prisma/client node_modules/prisma && npm install prisma@5.22.0 @prisma/client@5.22.0 && npm run db:generate -w apps/api`
- DB enum isimleri: `booking_status`, `ingest_status`, `incident_severity`
- Local DB 2026-04-22'de 8 migration baseline edildi
- 2026-04-26: 10 adet tekrar eden index kaldırıldı
- 2026-04-28: `weekly_shift_assignments` migration eklendi
- 2026-04-29: `booking_work_tracking` migration eklendi

## Ortam Değişkenleri

Ana dosya: `.env`

```bash
NODE_ENV=production
DATABASE_URL=postgresql://...
RABBITMQ_URL=amqp://...
KEYCLOAK_CLIENT_ID=bcms-api
KEYCLOAK_ALLOWED_ISSUERS=http://<LAN_IP>:8080/realms/bcms,http://localhost:8080/realms/bcms
KC_HOSTNAME=<LAN_IP>
KC_HOSTNAME_PORT=8080
INGEST_CALLBACK_SECRET=...
INGEST_ALLOWED_ROOTS=/opta,/app/tmp/watch
BCMS_BACKGROUND_SERVICES=none
OPTA_WATCHER_API_TOKEN=...
BXF_WATCH_DIR=/app/tmp/bxf
CORS_ORIGIN=http://<LAN_IP>:4200,http://localhost:4200
```

### LAN / Ağ Erişimi

Farklı bir bilgisayardan erişimde iki ayar zorunludur:

1. **Keycloak redirect_uri**: `infra/keycloak/realm-export.json`'da `bcms-web` client'ına LAN IP eklenmeli.
2. **Token issuer**: `KEYCLOAK_ALLOWED_ISSUERS` env değişkeni ile birden fazla issuer kabul eder.

## OPTA

OPTA SMB watcher ayrı Python konteyneri (`opta-watcher`) olarak çalışır.
`POST /api/v1/opta/sync` endpoint'i **Bearer token** kimlik doğrulaması gerektirir.

### Watcher davranışı (`scripts/opta_smb_watcher.py`)

- `MTIME_SETTLE_SEC = 5`
- `BATCH_SIZE = 100`
- Tarama aralığı: `OPTA_POLL_INTERVAL` (varsayılan 3600 sn)

### Sync endpoint davranışı

- Benzersiz ligler toplu upsert edilir.
- Mevcut maçlar tek sorguda çekilir.
- Tüm insertlar ve updatelar tek bir Prisma `$transaction` içinde yazılır.

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
