# BCMS Developer Guide

Bu dosya, projenin teknik mimarisini ve geliştirme süreçlerini kapsayan ana geliştirici rehberidir. Günlük operasyonlar ve bağlantı bilgileri için masaüstündeki diğer belgelere başvurun.

> **Son güncelleme**: 2026-05-01 — Recording port normalize (ana + yedek port, normalized table, GiST exclusion DB-level) + OPTA cascade (match shift'i bağlı schedule'lara delta-based yansır, version optimistic lock, FROZEN_STATUSES) + Auth interceptor 403 loop fix (HTTP error vs token error ayrımı, throttle) + Yeni Ekle dialog'da İçerik Türü gate (Müsabaka). Önceki tur (2026-04-30): audit triage 4-madde + Teknik Detay dedup + postgres_backup sidecar.

## Mimari Kurallar

1. **Servis izolasyonu**: API ve arka plan worker'ları ayrı Docker konteynerlerinde çalışır. `api` servisi yalnızca HTTP isteklerini karşılar (`BCMS_BACKGROUND_SERVICES=none`). Worker servisi RabbitMQ tüketimi, dosya izleme ve periyodik bakım job'larını üstlenir.
2. **Graceful shutdown**: `SIGTERM` alındığında Fastify önce yeni istekleri reddeder, devam eden işlemleri bekler, DB ve RabbitMQ bağlantılarını kapatır. Zaman aşımı: 30 sn (API), 60 sn (worker).
3. **Degraded mod**: OPTA dizini veya RabbitMQ geçici olarak ulaşılamaz olduğunda API çökmez. `/health` endpoint `status: "degraded"` + HTTP **503** döner; temel DB işlemleri devam eder.
4. **usageScope kuralı**: `schedules.usage_scope` kolonu karar noktasıdır. `broadcast` = normal yayın, `live-plan` = canlı yayın planı. Metadata JSON filtresi kullanılmaz.
5. **Prisma üzerinden erişim**: `usage_scope` dahil tüm DB erişimi Prisma Client ile yapılır. Ham SQL köprüsü eklenmez.
6. **Audit log**: Tüm write işlemleri `apps/api/src/plugins/audit.ts` Prisma `$extends` ile `audit_logs` tablosuna yazılır.
   - HTTP request bağlamında audit kayıtları başarılı yanıtlarda `onSend` içinde toplu yazılır.
   - Audit flush hatası artık sessiz geçilmez; API `500` döndürür. Worker/background write path de audit hatasını yutmaz.
7. **Statik servis**: Angular build dosyaları `infra/docker/nginx.conf` üzerinden nginx ile sunulur.
8. **Excel**: Yalnızca `exceljs` kullanılır; `xlsx` paketi güvenlik açığı nedeniyle kaldırılmıştır.
9. **Angular production ortamı**: `apps/web/angular.json`'da production konfigürasyonunda `fileReplacements` tanımlı olmalıdır.
10. **Rate limiting**: API global olarak dakikada 300 istek sınırına tabidir. `/health`, `/metrics`, ingest `/callback` ve `/opta/sync` muaftır.
11. **Güvenlik header'ları**: nginx tüm yanıtlara 6 güvenlik header'ı ekler.
12. **Input validation**: Tüm API route'ları Zod ile doğrulama yapar.
13. **Runtime port erişimi**: Web ve Keycloak LAN erişimi için dış arayüzlere açıktır (`4200:80`, `8080:8080`). API, DB, RabbitMQ, Prometheus, Grafana ve MailHog host-local kalır.
14. **Prisma connection pool**: API `connection_limit=10`, worker `connection_limit=5`, her ikisi `pool_timeout=20` kullanır. Ayar `apps/api/src/plugins/prisma.ts` içinde `BCMS_BACKGROUND_SERVICES` değerine göre yapılır.
15. **RabbitMQ publisher confirms**: `apps/api/src/plugins/rabbitmq.ts` `createConfirmChannel()` kullanır; `publish()` Promise-wrapped `sendToQueue` ile broker ack bekler. Bağlantı yokken silent drop yerine throw eder.
16. **Otomatik yedekleme**: `postgres_backup` sidecar (prodrigestivill/postgres-backup-local:16) günlük 03:00 Europe/Istanbul'da pg_dump alır. Dosyalar `infra/postgres/backups/`. Retention: 7 günlük + 4 haftalık + 6 aylık. Restore prosedürü: `infra/postgres/RESTORE.md`.
17. **Recording port normalize (2026-05-01)**: Ingest plan item başına 1..2 port atanır (`primary` zorunlu + `backup` opsiyonel). Normalized tablo `ingest_plan_item_ports` (FK CASCADE) + tek GiST exclusion constraint cross-role overlap'i DB-level garanti eder (port meşgulse rol farkı yok). Canlı yayın listesinde "Kayıt Yeri" kolonu read-only — sadece Ingest sekmesinden edit edilir. `metadata.liveDetails.recordLocation` deprecated, defansif strip migration uygulandı.
18. **OPTA cascade (2026-05-01)**: OPTA sync'te match.matchDate değişirse, o maça bağlı tüm canlı yayın schedule'ları (orijinal + duplicate'lar — `metadata.optaMatchId` üzerinden) **delta-based shift** edilir. Manuel ayarlar (transStart/transEnd) korunur, version optimistic lock ile eş zamanlı user edit override edilmez. `FROZEN_STATUSES` (`COMPLETED`, `CANCELLED`, `ON_AIR`) cascade dışında. Conflict durumunda `manualReconcileRequired:true` response sinyali — otomatik retry yok (drift scan follow-up PR).

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
| `worker` | bcms_worker | RabbitMQ consumer, ingest, bxf, notifications, audit retention | Healthcheck disabled — worker HTTP port açmaz |
| `opta-watcher` | bcms_opta_watcher | SMB → API HTTP sync (Python), state volume `/data` | `healthy` |
| `web` | bcms_web | Angular statik dosyalar (nginx) | `healthy` |
| `postgres` | bcms_postgres | PostgreSQL 16 | — |
| `rabbitmq` | bcms_rabbitmq | Mesaj kuyruğu | — |
| `keycloak` | bcms_keycloak | Kimlik doğrulama | — |
| `prometheus` | bcms_prometheus | Metrikler | — |
| `grafana` | bcms_grafana | Dashboard | — |
| `mailhog` | bcms_mailhog | SMTP (dev) | — |
| `postgres_backup` | bcms_postgres_backup | Günlük pg_dump + retention (7/4/6) | localhost:8080 wget |

> **Worker Health (2026-04-30)**: `bcms_worker` HTTP sunucusu çalıştırmadığı için Docker Compose worker healthcheck'i devre dışıdır. Worker durumu loglar, RabbitMQ consumer başlangıç mesajları ve background job logları ile izlenir.

> **Runtime Audit v2 (2026-04-30)**: Web, API, Keycloak, PostgreSQL, RabbitMQ ve OPTA watcher sağlıklı doğrulandı. `/api/v1/opta/sync` bombardımanı durdu; saatlik düşük frekanslı sync normal kabul edilir. `prisma migrate diff` boş çıktı verdi; DB ve Prisma schema eşleşiyor.

> **Stabilizasyon fazı (2026-04-30)**: Studio Plan kayıt akışı `debounceTime(400)` + `switchMap` ile son state'i kaydeder. Audit retention worker job, DB connection tuning, production `as any` temizliği ve 25/25 headless web test seti doğrulandı.

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
docker compose up -d --build web

# Durdur
docker compose down
```

Adresler:
- Web: `http://172.28.204.133:4200`
- API: `http://127.0.0.1:3000` (host-local; LAN erişimi nginx `/api` proxy üzerinden)
- Swagger: `http://172.28.204.133:4200/docs`
- Keycloak: `http://172.28.204.133:8080`

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

`.env.example` güncel runtime kapsamını yansıtır: `DATABASE_URL`, `RABBITMQ_URL`, Keycloak URL/realm/issuer/client env'leri, `OPTA_WATCHER_API_TOKEN`, watcher klasörleri, proxy çıktı dizini ve SMTP kullanıcı/parola alanları dahil edilmiştir.

`apps/api/src/core/keycloak-admin.client.ts` Keycloak Admin API erişimini merkezi yönetir:
- admin token cache kullanır,
- `kcFetch<T>()` ile typed fetch sarmalayıcı sağlar,
- production ortamda eksik Keycloak Admin env değerlerinde fallback yapmaz, fail-fast davranır.

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

> **Frontend cache notu:** Web image rebuild sonrası tarayıcıda eski bundle kalırsa `Ctrl+Shift+R` hard refresh yapılmalıdır. Docker'daki `bcms_web` container eskiyse local `npm run build -w apps/web` sonucu kullanıcıya görünmez; `docker compose up -d --build web` gerekir.

### Görsel/Export Notları — 2026-04-29

- Stüdyo Planı `Export PDF` ana uygulama DOM'unu yazdırmaz; yalnızca `#studio-plan-export` alanını ayrı print penceresine klonlar.
- PDF print hedefi A3 landscape (`420mm x 297mm`) ve `margin: 0` olarak tanımlıdır.
- Canlı Yayın Planı tablo gövdesinde başlıklar hariç içerik fontu büyütülmüş ve kalınlaştırılmıştır. Aksiyon ikonları bu büyütmeden hariç tutulur.
- Stüdyo Planı hızlı hücre değişimleri için kayıt akışı `debounceTime(400)` + `switchMap` kullanır; UI anında güncellenir, yalnızca son state backend'e yazılır.

### Test ve Audit Durumu — 2026-04-30

- API/Web/Shared production build doğrulandı.
- Frontend tarafında `api.service`, `schedule.service`, `auth.guard`, `studio-plan`, `schedule-list`, `ingest-list` ve `schedule-reporting` için 25 headless Karma test geçiyor.
- Büyük component'lerde test kapsamı başlamıştır; davranış kapsamı hâlâ genişletilmelidir.
- `npm audit`: high/critical yok; 7 moderate vulnerability ayrı branch'te `npm audit fix --dry-run` ile ele alınmalıdır.
- `audit_logs` tablosu büyümeye açıktır; worker tarafındaki audit retention job ve `AUDIT_RETENTION_DAYS` env değeri korunmalıdır.
- Production kodundaki kritik `as any` cast'leri `auth.guard.ts`, `booking.service.ts`, `audit.routes.ts` ve `opta.parser.ts` içinde explicit typing/Prisma DTO/type guard yaklaşımıyla temizlenmiştir.
- `postcss` ve `uuid` kaynaklı 7 moderate npm advisory production runtime etkisi düşük olduğu için dokümante edilmiştir; `npm audit fix --force` Angular peer dependency conflict nedeniyle kullanılmamalıdır.

### Grup Tabanlı Yetkilendirme (RBAC)

12 grup: `Admin`, `Tekyon`, `Transmisyon`, `Booking`, `YayınPlanlama`, `SystemEng`, `Ingest`, `Kurgu`, `MCR`, `PCR`, `Ses`, `StudyoSefi`

`Admin` ve `SystemEng` sistem genelinde tam yetkili kabul edilir. Grup adları Keycloak'taki `groups` claim değeriyle birebir aynı olmalıdır; route içinde eski veya farklı yazılmış grup string'i kullanılmamalıdır.

### Oturum Yenileme — 2026-04-30

- Frontend Keycloak token'ını uygulama açık kaldığı sürece periyodik olarak yeniler.
- API isteklerinden önce `updateToken(60)` çağrılır ve güncel bearer token header'a eklenir.
- **Token refresh başarısız olursa** (örn. refresh token expired): interceptor request'i eski/boş token ile geçirmez; `keycloak.login()` ile login akışına yönlendirir ve hatayı propagate eder. Önceki davranışta 401-loop'a girip session kurtarma asla tetiklenmiyordu — fix `apps/web/src/app/core/interceptors/auth.interceptor.ts`.
- Kullanıcı explicit `Çıkış yap` butonuna basmadığı sürece frontend logout tetiklemez.
- Tarayıcı/app tamamen kapalı kalır ve Keycloak realm max session süresi aşılırsa yeniden login gerekebilir; bu süre Keycloak realm policy ile yönetilir.

| Sekme / Özellik | Erişim |
|---|---|
| Yayın Planı listesi | Tüm authenticated |
| Tam ekran | Tüm authenticated |
| Yeni Ekle | Admin, SystemEng, Booking, YayınPlanlama |
| Düzenle | Admin, SystemEng, Tekyon, Transmisyon, Booking, YayınPlanlama |
| Teknik Detay | Admin, SystemEng, Transmisyon, Booking |
| Çoğaltma | Admin, SystemEng, Tekyon, Transmisyon, Booking |
| Silme | Admin, SystemEng, Tekyon, Transmisyon, Booking, YayınPlanlama |
| **Sorun Bildir** | **Admin, SystemEng, Tekyon, Transmisyon** |
| Stüdyo Planı görüntüle | Tüm authenticated |
| Stüdyo Planı düzenle | Admin, SystemEng, StudyoSefi |
| **Ekip İş Takip** | **Tüm gruplar kendi grubunun işlerini görür; Admin/SystemEng tüm grupları görür** |
| **Haftalık Shift** | **Tüm gruplar kendi grubunun shiftini görür; supervisor kendi grubunu düzenler; Admin/SystemEng tümünü düzenler** |
| Ingest | Admin, SystemEng, Ingest |
| MCR | Admin, SystemEng, MCR |
| Kullanıcılar | Admin, SystemEng |
| Ayarlar | Admin, SystemEng |
| Provys, Kanallar, Monitoring | Admin, SystemEng |

Yetki matrisi: `packages/shared/src/types/rbac.ts` → `PERMISSIONS` sabiti.
API: `app.requireGroup(...groups)`
Frontend: `tokenParsed.groups` + `computed()` sinyaller.

### Ekip İş Takip (Booking / Work Tracking) — 2026-04-29

- Konum: `Ekip İş Takip` navigasyon öğesi
- Modül: `apps/web/src/app/features/bookings/`
- Backend: `apps/api/src/modules/bookings/`
- Tablo: `bookings`
- Liste görünümü (mat-table): İş Başlığı, Grup, Oluşturan, Durum, Tarih, Sorumlu, Aksiyonlar
- Durumlar: `PENDING` (Açık), `APPROVED` (Tamamlandı), `REJECTED` (Reddedildi), `CANCELLED` (İptal)
- Sıralama: PENDING işler yukarıda, sonra `startDate`'e göre
- Dialog: `BookingTaskDialogComponent` — İş Başlığı, Grup, Başlama/Tamamlanma Tarihi, Sorumlu, Durum, Detaylar, Rapor
- API: `GET/POST/PATCH/DELETE /api/v1/bookings`
- Görünürlük: kullanıcı sadece kendi grubunun işlerini görür. `Admin`/`SystemEng` tüm grupları görür.
- İş oluşturma: tüm authenticated kullanıcılar kendi grubu için iş başlığı oluşturabilir.
- Sorumlu seçme: grup `supervisor` kullanıcısı veya `Admin`/`SystemEng` yapabilir.
- Silme: işi oluşturan, atanan sorumlu, grup supervisor'ı veya `Admin`/`SystemEng`.

### Haftalık Shift (Weekly Shift) — 2026-04-29

- Konum: `Haftalık Shift` navigasyon öğesi
- Modül: `apps/web/src/app/features/weekly-shift/`
- Backend: `apps/api/src/modules/weekly-shifts/`
- Tablolar: `weekly_shifts`, `weekly_shift_assignments`
- Haftalık tablo (Pzt-Paz), her hücrede izin veya giriş/çıkış saati
- İzin tipleri: `OFF_DAY`, `HOME`, `OUTSIDE`, `NIGHT`, `SIC_CER`, `HOLIDAY`, `ANNUAL`
- Giriş saatleri: `05:00`, `06:00`, `07:45`, `10:00`, `12:00`, `14:45`, `16:30`, `23:30`
- Excel/PDF export: Renkli hücreler, zebra striping
- Çıkış saatleri: `06:15`, `13:15`, `15:00`, `16:45`, `20:00`, `22:00`, `23:45`
- Kural: bir hücrede ya izin ya saat bilgisi olur; ikisi aynı anda seçilemez.
- Görünürlük: kullanıcı sadece kendi grubunun shiftini görür. `Admin`/`SystemEng` tüm grupları görür.
- Düzenleme: grup `supervisor` kullanıcısı kendi grubunu, `Admin`/`SystemEng` tüm grupları düzenler.
- API: `GET /api/v1/weekly-shifts`, `PUT /api/v1/weekly-shifts/:weekStart`

### Stüdyo Planı

- `StudyoSefi`, `SystemEng` ve `Admin` tam yetkili; diğerleri yalnızca liste görünümü.
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
- Port Görünümü tam ekran modunda `100vh` flex yerleşim kullanır; tablo alanı ekranın kalan yüksekliğini doldurur.

## Yerel Altyapı (Docker)

| Servis | Port | Erişim | Konteyner |
|---|---|---|---|
| API | **127.0.0.1:3000** | Sadece localhost | bcms_api |
| PostgreSQL | **127.0.0.1:5433** / 5432 (container) | Sadece localhost | bcms_postgres |
| RabbitMQ AMQP | **127.0.0.1:5673** / 5672 (container) | Sadece localhost | bcms_rabbitmq |
| RabbitMQ UI | **127.0.0.1:15673** | Sadece localhost | bcms_rabbitmq |
| Keycloak | **0.0.0.0:8080** | LAN erişimi açık | bcms_keycloak |
| Web | **0.0.0.0:4200** | LAN erişimi açık | bcms_web |
| Prometheus | **127.0.0.1:9090** | Sadece localhost | bcms_prometheus |
| Grafana | **127.0.0.1:3001** | Sadece localhost | bcms_grafana |
| Mailhog UI | **127.0.0.1:8025** | Sadece localhost | bcms_mailhog |

## Prisma

- Sürüm: 5.22.0
- Generate sorunu çözümü: `rm -rf node_modules/.prisma node_modules/@prisma/client node_modules/prisma && npm install prisma@5.22.0 @prisma/client@5.22.0 && npm run db:generate -w apps/api`
- DB enum isimleri: `booking_status`, `ingest_status`, `incident_severity`
- Local DB 2026-04-22'de 8 migration baseline edildi (toplam migration sayısı: 21; tam liste `apps/api/prisma/migrations/`)
- 2026-04-25: `add_ingest_job_updated_at`
- 2026-04-26: `ingest_port_no_overlap` (btree_gist exclusion constraint) + 10 adet tekrar eden index kaldırıldı
- 2026-04-27: `ingest_plan_report_index` (raporlama sorgu hızlandırması)
- 2026-04-28: `weekly_shift_assignments` migration eklendi
- 2026-04-29: `booking_work_tracking` migration eklendi
- 2026-04-29: `integrity_constraints` migration eklendi: `schedules_no_channel_time_overlap` exclusion constraint ve `incidents_open_signal_loss_channel_uidx` partial unique index.
- 2026-04-30: `reconcile_cascades_and_enums` — cascade davranışları + enum isimleri reconcile edildi; `prisma migrate diff` boş.
- 2026-04-30: `strip_obsolete_live_detail_keys` — Tahta/Kaynak ve Yedek Kaynak Teknik Detay'dan kaldırıldı; defansif idempotent jsonb minus ile 16 obsolete key strip edildi (pre-check 0 etkilenen, post-check 0 kalan).
- 2026-04-30: `normalize_recording_ports` — yeni `ingest_plan_item_ports` tablosu (plan_item_id FK CASCADE, port_name, role∈{primary,backup}, denormalized day+start+end). Mevcut 48+ `recording_port` satırı role='primary' ile yeni tabloya migrate edildi. Eski `no_port_time_overlap` exclusion + `recording_port` kolonu drop. Yeni `ingest_plan_item_ports_no_overlap` GiST exclusion cross-role overlap'i DB-level garanti eder. UNIQUE(plan_item_id, role) + UNIQUE(plan_item_id, port_name) ile aynı item içinde primary≠backup zorunlu. Defansif `metadata.liveDetails.recordLocation` strip de aynı migration'da.

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
3. **Canlı realm güvenliği**: Mevcut realm startup import ile overwrite edilmez. `sslRequired=external` değerini çalışan realm'e uygulamak için `ops/scripts/bcms-keycloak-apply-security.sh` kullanılır.

## OPTA

OPTA SMB watcher ayrı Python konteyneri (`opta-watcher`) olarak çalışır.
`POST /api/v1/opta/sync` endpoint'i **timing-safe Bearer token** kimlik doğrulaması gerektirir ve rate limit dışındadır.

### Watcher davranışı (`scripts/opta_smb_watcher.py`)

- `MTIME_SETTLE_SEC = 5`
- `BATCH_SIZE = 100`
- Tarama aralığı: `OPTA_POLL_INTERVAL` (varsayılan 3600 sn)

### Sync endpoint davranışı

- Benzersiz ligler toplu upsert edilir.
- Mevcut maçlar tek sorguda çekilir.
- Tüm insertlar ve updatelar tek bir Prisma `$transaction` içinde yazılır.
- Python watcher Docker bridge network üzerinden `http://api:3000/api/v1` adresine gider; host network kullanılmaz.

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

## Yedekleme & DR

- **Sidecar**: `postgres_backup` (image `prodrigestivill/postgres-backup-local:16`)
- **Schedule**: günlük 03:00 Europe/Istanbul (cron `0 3 * * *`)
- **Retention**: 7 günlük + 4 haftalık + 6 aylık
- **Veritabanları**: `bcms` + `keycloak`
- **Konum**: `infra/postgres/backups/{daily,weekly,monthly,last}/` (host bind mount, gitignored)
- **Healthcheck**: `docker exec bcms_postgres_backup wget -qO- http://localhost:8080`
- **Manuel tetik**: `docker exec bcms_postgres_backup /backup.sh`
- **Restore runbook**: `infra/postgres/RESTORE.md`
- **Bilinen quirk (v1)**: Image v0.0.11 wrapper `.sql.gz` uzantılı dosyaları **gerçekte gzip'lemiyor** — dosyalar plain SQL. Restore için `cat` (gunzip değil) kullanılır. Follow-up: gerçek compression için tool değişikliği.
- **Off-host kopya**: Henüz yok. Mevcut sidecar tek host'ta kalıyor — disk arızasından korumaz. Follow-up seçenekler RESTORE.md'de listeli (rsync/S3/borg).
- **Recovery drill**: Çeyreklik tatbikat önerilir (`infra/postgres/RESTORE.md` "Recovery drill" bölümü).

## Canlı Yayın Plan UX — 2026-04-30 / 2026-05-01 Refactor Notları

- **Düzenle dialog**: Temel meta + Mod Tipi / Coding Tipi / Demod / IRD slot 1/2/3 / Fiber slot 1/2 / TIE / Sanal / intField/intField2 / Off Tube / Notlar. **Kayıt Yeri input'u kaldırıldı** (2026-05-01) — Ingest sekmesi tek edit noktası.
- **Teknik Detay Düzenle dialog**: Sadece Ana Feed/Transmisyon, Yedek Feed, Fiber bölümleri. Tahta/Kaynak ve Yedek Kaynak gruplar tamamen **kaldırıldı** (UI + DB).
- **Düzenle ile paylaşılan 9 key** (`modulationType, videoCoding, demod, recordLocation, tie, virtualResource, ird, ird3, fiberResource`) Teknik Detay'da gizlenir — duplicate UX engellendi. Tek kayıt yolu Düzenle. (`recordLocation` artık deprecated — Ingest'ten gelir.)
- **Yeni Ekle dialog**: Teknik Detaylar tab'ı **kaldırıldı** (2026-04-30). 2026-05-01: yeni Step 1 **İçerik Türü** (Müsabaka opsiyonu) — seçilmeden Step 2 (İçerik Seçimi) hiç görünmez. Step 3 (Maç Seç / Maç Bilgileri) Müsabaka akışında.
- **TIE dropdown**: 20 öğe (1-6, IRD 48-50 RBT, PLT SPR5-8, STREAM1/2 PC, TRX SPR14-18). Eski free-text kayıtlar sticky-defensive ile listenin başında kalır.
- **Mod Tipi dropdown**: 18 öğe (4,5G, DVB S, DVB S2, DVB S2 - 8PSK, DVB S2 QPSK, DVBS2 + NS3, DVBS-2 + NS4, DVB-S2X, FTP, IP Stream, NS3, NS3 + NS4, NS4, NS4 + NS4, Quicklink, Skype, Youtube, Zoom).
- **Sanal dropdown** (2026-05-01): text input → mat-select `1` / `2` (sticky-defensive eski free-text).
- **Tablo Kayıt Yeri kolonu** (2026-05-01): read-only, Schedule.recordingPort + backupRecordingPort'tan format `Port 5 - Port 12` (önceden `(yedek)` etiketi vardı, kaldırıldı; "/" → "-" symmetric ayraç).
- **Tablo Int kolonu** (2026-05-01): "/" → "-" symmetric ayraç (intField + intField2 birleştirme).

## Ingest Sekmesi — Recording Port (2026-05-01)

- **2 dropdown per row**: "Kayıt Portu" (zorunlu) + "Yedek Kayıt Portu" (opsiyonel)
- **Same-item exclusivity**: aynı item'da primary == backup imkansız (DB UNIQUE + UI cross-disable)
- **Cross-item busy-port warning**: dropdown'da her port option'u, başka item'da aynı saatte kullanılıyorsa **turuncu (#ff9800) "· meşgul"** etiketi + disabled. Server 409'a düşmeden kullanıcı görür. (Mid-edit time değişikliğinde feedback bir CD cycle gecikir — sınır.)
- **Atomic write**: PUT `/ingest/plan/:sourceKey` — Prisma `$transaction` ile parent + ports replace strategy (deleteMany + create x{1,2}).
- **Cross-role overlap**: tek GiST exclusion constraint (port_name × day × time_range) ana × ana, ana × yedek, yedek × yedek hepsini yakalar. Pre-check `findFirst` defense-in-depth — daha açıklayıcı hata mesajı için.

## Ingest Port Görünümü Fullscreen (2026-04-30/05-01)

- **Tüm portlar tek ekrana sığar** — yatay/dikey scroll yok. 5 satır × ~9 kolon = 45+ port viewport'a eşit dağılır (`grid-template-columns: minmax(0, 1fr)` + `display:grid` rows).
- **Item layout**: time-grid yerine **flex-column özet liste**. Saat-precision kaybı kabul edildi — content readability tercih edildi (200px column-body'ye 24h time-grid sıkıştırınca 30 dk item ~8px = okunmaz oluyordu).
- **Font ölçekleme**: column tag (port adı) 1.55rem, item title 1.05rem, time 0.95rem, note 0.85rem — okunabilir + kompakt.
- **Normal mod (non-fullscreen)**: eski time-grid davranışı korundu.

## OPTA Cascade — Match Date Değişimi (2026-05-01)

OPTA sync'te bir maçın `matchDate` değişirse, o maça bağlı **tüm canlı yayın schedule'lar** (orijinal + duplicate'lar) otomatik aynı delta ile shift edilir.

**Filtre**:
- `usageScope='live-plan'` + `metadata.optaMatchId === matchUid`
- `status NOT IN ('COMPLETED', 'CANCELLED', 'ON_AIR')` (FROZEN_STATUSES)

**Shift detayı**:
- Delta = `newMatchDate − oldMatchDate`
- Top-level: `startTime`, `endTime` += delta
- Metadata: `transStart`, `transEnd` (HH:MM string) += delta (24h wrap, range check `<24:<60`)
- Version optimistic lock: `updateMany({where: {id, version}})` + count check. Eş zamanlı user edit varsa skip + warn.

**Best-effort**:
- Cascade ana OPTA tx **dışında** — bir schedule conflict'i tüm sync'i rollback etmez.
- Tüm exception outer try/catch'te yakalanır → response 500 dönmez.
- Per-iteration try/catch → bir schedule patlasa diğerleri çalışır.

**Response shape** (POST `/api/v1/opta/sync`):
```json
{
  "inserted": 0, "updated": 1, "unchanged": 0,
  "cascadedSchedules": 7, "cascadeConflicts": 0,
  "manualReconcileRequired": false,
  "cascadeError": null
}
```

**⚠ Drift riski**: Conflict (version mismatch / channel-overlap) yaşayan schedule **kalıcı olarak eski saatte kalır** — OPTA sync sonraki turda match.matchDate'i tekrar değiştirmedikçe cascade tetiklenmez. `manualReconcileRequired:true` sinyali + log'da scheduleId/matchUid/delta. Drift correction follow-up PR (backfill migration + `metadata.optaAppliedMatchDate` field + her sync'te tarama döngüsü atomik introduction olarak).

**RabbitMQ event**: her başarılı cascade için `QUEUES.SCHEDULE_UPDATED` payload `{scheduleId, changes: {startTime, endTime, metadata?}, source: 'opta-cascade'}`. Publish hatası cascade başarısını etkilemez (best-effort).

**Dedupe**: payload aynı `matchUid`'i 2× içerirse `Map<matchUid>` ile tekilleştirilir (schema garanti etmediği için defansif).

## Auth Interceptor — 2026-05-01 Fix

- **Sebep**: önceki sürümde `catchError` HTTP error (401/403) ile token error'ı ayırt etmiyordu. Tekyon group user `/channels` endpoint'inde 403 alıyordu (`PERMISSIONS.channels.read=['SystemEng']`) → interceptor `keycloak.login()` redirect → sayfa reload → ngOnInit → 403 → reload → **sonsuz loop**.
- **Fix**: `catchError` artık error tipini ayırır:
  - `HttpErrorResponse` (401/403/500) → propagate, REDIRECT YOK (component/global handler işler)
  - Token-fetch / Keycloak-instance hatası → throttle'lı redirect (sessionStorage 30sn pencere)
- Token gerçekten geçersizse `keycloak.login()` redirect, ama HTTP permission errorları sayfa reload tetiklemez.

## Operasyon Belgeleri

- `/home/ubuntu/Desktop/BCMS_BAGLANTI_BILGILERI.txt` — bağlantı ve kimlik bilgileri
- `ops/README.md` — Docker Compose operasyon özeti
- `ops/NOTES_FOR_CODEX.md` — gelecekteki oturumlar için teknik not
- `infra/postgres/RESTORE.md` — pg_dump restore runbook (single DB / Keycloak / full disaster)
- `BCMS_DETAILED_AUDIT_REPORT_2026-04-30.md` — kapsamlı audit raporu (triage edildi: 4 maddeden 3'ü uygulandı, 1 false-positive)
