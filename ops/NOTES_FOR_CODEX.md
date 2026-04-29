# Notes For Future Codex Sessions

## ⚠️ CRITICAL USER INTERACTION RULE

**NEVER take any action before stating what you will do and receiving explicit user confirmation.**
Always explain the exact step, wait for approval (e.g., "Evet", "Tamam", "Do it", "Yap"), and only then execute.
This applies to all destructive operations (`git checkout`, `git reset`, `rm`, `docker system prune`), builds, and any file modifications.

---

## Mimari Kurallar (Değiştirilmez)

1. **API/Worker ayrıştırması**: `api` servisi `BCMS_BACKGROUND_SERVICES=none` ile çalışır. Worker servisi `notifications,ingest-worker,ingest-watcher,bxf-watcher` çalıştırır. OPTA Python watcher ayrı konteyner. Bu ayrım bozulmamalı.
2. **Graceful shutdown**: `server.ts`'de SIGTERM/SIGINT → `app.close()` → 30 sn timeout. Worker için 60 sn. `--force` veya anında kill önerilmez.
3. **usageScope kanonik**: `schedules.usage_scope` DB kolonudur. Metadata JSON filtresi yoktur. Ham SQL köprüsü eklenmez.
4. **Nginx static serve**: Angular dosyaları `infra/docker/web.Dockerfile` → nginx:alpine ile sunulur.
5. **Audit log**: `apps/api/src/plugins/audit.ts` Prisma `$extends` ile tüm write işlemlerini loglar. Bu plugin'i devre dışı bırakma.
6. **Angular production environment**: `apps/web/angular.json` production konfigürasyonunda `fileReplacements` ile `environment.ts` → `environment.prod.ts` değişimi tanımlı olmalı.

## Primary Runtime

```bash
docker compose up -d
docker compose logs -f
docker compose down
docker compose up -d --build api worker  # kod değişikliğinden sonra
docker compose up -d --build web         # frontend değişikliğinden sonra
```

Adresler:
- Web: `http://172.28.204.133:4200`
- API: `http://127.0.0.1:3000` (host-local)
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
prometheus → Metrikler
grafana    → Dashboard
mailhog    → SMTP (dev)
```

> **Not (2026-04-29)**: `bcms_worker` HTTP sunucusu çalıştırmadığı için Docker Compose worker healthcheck'i devre dışıdır. Worker durumu loglar ve consumer başlangıç kayıtlarıyla izlenir.

> **Not (2026-04-29, build/runtime)**: Local `npm run build -w apps/web` Docker'daki `bcms_web` container'ı güncellemez. Görsel/frontend değişikliklerinden sonra `docker compose up -d --build web` çalıştır ve tarayıcıda `Ctrl+Shift+R` hard refresh iste.

## Degraded Mod

OPTA dizini veya RabbitMQ geçici koptuğunda API çökmez:
- `/health` endpoint `status: "degraded"` ve `checks` objesi döner (HTTP **503**)
- RabbitMQ `rabbitmq.isConnected()` ile sorgulanabilir
- OPTA `getOptaWatcherStatus()` ile sorgulanabilir
- DB koptuğunda operasyonel etki vardır

## Grup Tabanlı Auth (2026-04-29 — CANLI KEYCLOAK İLE HİZALI)

Auth sistemi rol tabanlıdan **grup tabanlıya** geçirildi.

### Gruplar (12 adet)
`Admin`, `Tekyon`, `Transmisyon`, `Booking`, `YayınPlanlama`, `SystemEng`, `Ingest`, `Kurgu`, `MCR`, `PCR`, `Ses`, `StudyoSefi`

`Admin` ve `SystemEng` sistem genelinde tam yetkili kabul edilir. Grup adları Keycloak `groups` claim'i ile birebir aynı yazılmalıdır. Route içinde grup stringlerini hardcode etme; `@bcms/shared` içindeki `PERMISSIONS` ve `BCMS_GROUPS` kullanılmalıdır.

### Mimari
- Keycloak: `oidc-group-membership-mapper` → JWT `groups` claim
- API: `requireGroup(...groups)` — boş array = tüm authenticated, doluysa grup üyeliği zorunlu
- Frontend: `tokenParsed.groups` + `computed()` sinyaller
- Kaynak: `packages/shared/src/types/rbac.ts` → `BcmsGroup` tipi + `PERMISSIONS` matrisi

### Yetki Matrisi
```
schedules.read:          [] (tüm authenticated)
schedules.add:           ['SystemEng', 'Booking', 'YayınPlanlama'] + Admin bypass
schedules.edit:          ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] + Admin bypass
schedules.technicalEdit: ['SystemEng', 'Transmisyon', 'Booking'] + Admin bypass
schedules.duplicate:     ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking'] + Admin bypass
schedules.delete:        ['SystemEng', 'Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] + Admin bypass
incidents.read/write/delete: ['SystemEng'] + Admin bypass
incidents.reportIssue:   ['SystemEng', 'Tekyon', 'Transmisyon'] + Admin bypass
ingest.read/write/delete:['SystemEng', 'Ingest'] + Admin bypass
ingest.reportIssue:      [] (tüm authenticated)
studioPlans.read:        [] (tüm authenticated)
studioPlans.write/delete:['SystemEng', 'StudyoSefi'] + Admin bypass
bookings.read/write/delete: [] route seviyesinde tüm authenticated; servis içinde grup izolasyonu uygulanır
weeklyShifts.read/write: [] route seviyesinde tüm authenticated; servis içinde grup izolasyonu uygulanır
weeklyShifts.admin:      ['Admin', 'SystemEng']
```

### Kullanıcı Yönetimi — KRİTİK
Keycloak Admin API kullanır. `docker-compose.yml` api servisinde `KEYCLOAK_ADMIN: ${KEYCLOAK_ADMIN}` ZORUNLU.
Ortak helper: `apps/api/src/core/keycloak-admin.client.ts`. `getAdminToken()` token cache kullanır; `kcFetch<T>()` typed wrapper'dır. Production'da eksik `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_ADMIN` fallback'e düşmemeli, fail-fast olmalıdır.

## Sorun Bildir — Canlı Yayın Planı (2026-04-26)

Canlı Yayın Plan Listesi ekranında her satırda **Sorun Bildir** ikonu bulunur.
- Görünürlük: `['SystemEng', 'Tekyon', 'Transmisyon']` + `Admin` bypass
- Kayıt: `POST /api/v1/incidents/report` → `incidents` tablosuna `eventType='SCHEDULE_ISSUE'`, `severity='ERROR'`

## Ekip İş Takip (Booking / Work Tracking) — 2026-04-29

- Modül: `apps/web/src/app/features/bookings/`
- Backend: `apps/api/src/modules/bookings/`
- Tablo: `bookings` (Prisma schema)
- Durumlar: `PENDING` (Açık), `APPROVED` (Tamamlandı), `REJECTED` (Reddedildi), `CANCELLED` (İptal)
- Frontend: Liste görünümü (mat-table), açık olanlar tarihe göre sıralı
- Sütunlar: İş Başlığı, Grup, Oluşturan, Durum, Tarih, Sorumlu, Aksiyonlar
- Dialog: `BookingTaskDialogComponent` — İş Başlığı, Grup, Başlama/Tamamlanma Tarihi, Sorumlu, Durum, Detaylar, Rapor
- API endpoint: `GET/POST/PATCH/DELETE /api/v1/bookings`
- Yetki: kullanıcı kendi grubunun işlerini görür ve iş oluşturabilir. Grup `supervisor` kullanıcısı sorumlu atayabilir; işi oluşturan veya sorumlu kişi silebilir. `Admin`/`SystemEng` tüm gruplarda tam yetkilidir.

## Haftalık Shift (Weekly Shift) — 2026-04-29

- Modül: `apps/web/src/app/features/weekly-shift/`
- Backend: `apps/api/src/modules/weekly-shifts/`
- Tablolar: `weekly_shifts`, `weekly_shift_assignments`
- Frontend: Haftalık tablo (Pzt-Paz), her hücrede izin veya saat bilgisi
- İzin tipleri: `OFF_DAY`, `HOME`, `OUTSIDE`, `NIGHT`, `SIC_CER`, `HOLIDAY`, `ANNUAL`
- UI: Inline editing, Excel/PDF export
- Excel export: Zebra striping, renkli hücreler, dondurulmuş başlıklar
- PDF export: Dark theme, renkli badge'ler
- Giriş saatleri: `05:00`, `06:00`, `07:45`, `10:00`, `12:00`, `14:45`, `16:30`, `23:30`
- Çıkış saatleri: `06:15`, `13:15`, `15:00`, `16:45`, `20:00`, `22:00`, `23:45`
- Kural: izin ve saat bilgisi aynı hücrede birlikte seçilemez.
- Yetki: kullanıcı kendi grubunu görür; grup `supervisor` kullanıcısı kendi grubunu düzenler; `Admin`/`SystemEng` tüm gruplarda tam yetkilidir.
- Tarih formatı: `gg.aa.yyyy`

## Stüdyo Planı

- `apps/web/src/app/features/studio-plan/`
- `studio_plans` + `studio_plan_slots` tabloları (schedules'tan ayrı)
- `GET/PUT /api/v1/studio-plans/:weekStart`, `GET/PUT /api/v1/studio-plans/catalog`
- `weekStart` Pazartesi tarihi olmak zorundadır
- Liste görünümünde geçmiş günler gizlenir
- `Export PDF` sadece `#studio-plan-export` DOM'unu ayrı print penceresine klonlar; A3 landscape, `margin: 0`. Ana app layout'unu doğrudan `window.print()` ile yazdırma, print preview 2 sayfa/boşluk üretebilir.

## Canlı Yayın Planı UI

- Dosya: `apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts`
- Tablo gövdesinde başlıklar hariç veri hücreleri büyük ve kalın font kullanır. Aksiyon hücresi (`td-actions`) bu büyütmeden hariç tutulur.
- Görsel değişiklik kullanıcıya yansımıyorsa önce `docker compose ps web` ile container yaşını kontrol et; eskiyse `docker compose up -d --build web`.

## Raporlama (`/schedules/reporting`)

| Rapor Tipi | Filtre | Excel | PDF |
|---|---|---|---|
| `live-plan` | Lig/hafta veya tarih aralığı | ✓ | ✓ |
| `studio-usage` | Tarih aralığı | ✓ (TOPLAM satırı) | ✓ (TOPLAM satırı) |
| `ingest` | Tarih aralığı | ✓ (TOPLAM satırı) | ✓ (TOPLAM satırı) |

## Ingest Planlama

- `Ingest Planlama`: Canlı yayın planı ve Stüdyo Planı kayıtlarını birleştiren tablo
- `Port Görünümü`: Port bazlı operasyonel pano
- Kayıt portları: `recording_ports` (varsayılan 1-44 + Metus1/Metus2 = 46 port)
- Saat düzenleme: 5 dk adımlı
- Burst polling: 6×10 sn
- `plannedStartMinute < plannedEndMinute` validation'ı korunmalı.
- Port overlap DB exclusion constraint ile de korunur; sadece frontend kontrolüne güvenme.

## Prisma

Sürüm: 5.22.0

Generate sorunu çözümü:
```bash
rm -rf node_modules/.prisma node_modules/@prisma/client node_modules/prisma
npm install prisma@5.22.0 @prisma/client@5.22.0
npm run db:generate -w apps/api
```

**Migration listesi (güncel — 2026-04-29):**
- `20260423000000_studio_plans` … `20260423005000_recording_ports_1_44_metus`
- `20260425000000_add_ingest_job_updated_at`
- `20260426000000_btree_gist_port_conflict`
- `20260428010000_weekly_shift_assignments` — Haftalık Shift tabloları
- `20260429010000_booking_work_tracking` — Ekip İş Takip tablosu
- `20260429020000_integrity_constraints` — schedule zaman çakışması exclusion constraint + açık signal incident partial unique index

**DB index temizliği (2026-04-26):** 10 duplicate index silindi.

## OPTA Watcher

- Python konteyneri (`opta-watcher`), SMB'den dosya okur
- API çağrısı: `POST /api/v1/opta/sync` (Bearer token)
- Env: `BCMS_API_URL=http://api:3000/api/v1`, `BCMS_API_TOKEN`
- Doğrudan PostgreSQL erişimi yok
- Docker bridge network (`bcms_net`), host network yok
- `/api/v1/opta/sync` rate limit dışındadır ve timing-safe Bearer token kontrolü kullanır.
- `MTIME_SETTLE_SEC=5`, `BATCH_SIZE=100`
- XML parse `defusedxml.ElementTree` ile yapılır; `xml.etree.ElementTree` geri getirilmemeli.
- Container `HOME=/data` kullanır; state dosyaları named volume üzerinde kalıcıdır.
- API sync lig ve maç yazımlarını tek Prisma transaction içinde yapar.

## Audit Log

- `apps/api/src/plugins/audit.ts` HTTP bağlamında write audit kayıtlarını successful response için `onSend` içinde flush eder.
- Audit flush hatası artık sessiz yutulmaz; API `500` döndürür. Worker/background bağlamındaki audit `createMany` hatası da propagate olmalıdır.

## Keycloak / Auth

- Keycloak oturumları **in-memory** tutulur. Docker restart sonrası tüm oturumlar geçersiz olur.
- Tarayıcı eski token'ı kullanmaya devam ederse → Ctrl+Shift+R (hard refresh) + yeniden giriş.
- Test kullanıcısı: `admin` / `admin123`
- `infra/keycloak/realm-export.json` yeni importlar için `sslRequired=external` içerir.
- Mevcut canlı realm import ile overwrite edilmez; `ops/scripts/bcms-keycloak-apply-security.sh` çalışan realm'e `sslRequired=external` uygular.

## LAN Erişimi ve Çoklu Issuer Desteği (2026-04-25)

`KC_HOSTNAME_STRICT=false` ile Keycloak token `iss` değerini isteği yapan IP'ye göre yazar.
API `KEYCLOAK_ALLOWED_ISSUERS` env değişkenini okur ve hepsini kabul eder.

## Güvenlik (2026-04-26 güncel)

- `SKIP_AUTH=true` production'da yasak
- `xlsx` paketi kaldırıldı → `exceljs`
- Keycloak production modunda: `start --import-realm`
- Input validation: Tüm API route'ları Zod ile doğrulama yapar
- Rate limiting: 300 istek/dk global; `/health`, `/metrics`, `/api/v1/ingest/callback`, `/api/v1/opta/sync` muaf
- nginx Güvenlik Header'ları: 6 adet
- Port Binding: API `127.0.0.1:3000`, PostgreSQL `127.0.0.1:5433`, RabbitMQ UI `127.0.0.1:15673`, Prometheus `127.0.0.1:9090`, Grafana `127.0.0.1:3001`, MailHog `127.0.0.1:8025`

## CI

`.github/workflows/ci.yml`:
1. npm ci + npm audit
2. Prisma cache temizliği + reinstall + generate
3. prisma migrate deploy
4. npm run test
5. npm run build
6. API başlat (`BCMS_BACKGROUND_SERVICES=none`)
7. npm run smoke:api

## Lokal Ortam

- PostgreSQL: Docker konteyneri (bcms_postgres)
- RabbitMQ: Docker konteyneri (bcms_rabbitmq)
- Sudo şifresi: `ubuntu`

## Kaldırılan Dosyalar (Artık Yok)

- `ops/scripts/bcms-web-static-server.mjs` → nginx
- `ops/scripts/bcms-db-bootstrap-empty.sh` → prisma migrate deploy
- `ops/scripts/bcms-install-cron-fallback.sh` → Docker Compose
- `ops/scripts/bcms-install-user-services.sh` → Docker Compose
- `ops/scripts/bcms-supervisor*.sh` → Docker Compose restart policy

## Önemli Dosya Konumları

```
apps/api/src/server.ts                           → graceful shutdown
apps/api/src/app.ts                              → buildApp, health, rate-limit
apps/api/src/plugins/auth.ts                     → JWT, allowedIssuers
apps/api/src/plugins/audit.ts                    → Prisma audit $extends
apps/api/src/modules/bookings/                   → Ekip İş Takip API
apps/api/src/modules/weekly-shifts/              → Haftalık Shift API
apps/web/src/app/features/bookings/              → Ekip İş Takip Frontend
apps/web/src/app/features/weekly-shift/          → Haftalık Shift Frontend
apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts → Canlı Yayın Planı
apps/web/src/app/features/studio-plan/           → Stüdyo Planı
apps/web/src/app/features/ingest/                → Ingest Planlama
apps/web/src/app/features/mcr/                   → MCR Panel
apps/web/angular.json                            → fileReplacements
apps/web/src/environments/environment.prod.ts    → skipAuth: false
infra/docker/nginx.conf                          → Angular serve + API proxy
infra/keycloak/realm-export.json                 → bcms-web client
docker-compose.yml                               → 10 servis
```
