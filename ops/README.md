# BCMS Operasyon — Docker Compose

> Son güncelleme: 2026-05-10 — **Madde 5 strangler M5-B1..B6 + M5-B7..B8 backend + M5-B10a done**. Yeni: `live_plan_entries` + `live_plan_technical_details` + `live_plan_transmission_segments` tabloları, 25 lookup tablo, `/api/v1/live-plan` + `/api/v1/live-plan/lookups/:type` + nested technical-details/segments API, K15 + L1-L12 + U1-U12 lock'lar, **Lookup Yönetim Ekranı** (`features/live-plan/admin-lookups/`), segments-only UI scaffold. Sıradaki frontend: **M5-B10b** (76 alanlı technical-details form). Eş zamanlı **SCHED-B5a Block 2** (2026-05-10): legacy `usage_scope` + `deleted_at` + `schedules_no_channel_time_overlap` GiST DROP migration hazır + BXF tamamen kaldırıldı (apply ayrı faz, backup şart). Eş zamanlı **Outbox + DLQ V1 (Madde 2+7)**: Phase 2 shadow tüm domain'lerde; PR-C1 poller deployed non-authoritative; PR-C2/PR-D production soak gate pending. Önceki turlar: RBAC yeniden yapılandırma (Admin tek full-yetki); recording port normalize; OPTA cascade; auth 403 fix.

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

# Frontend değişikliğinden sonra web image'ını yeniden build et
docker compose up -d --build web

# Servisi yeniden başlat (build'siz)
docker compose restart api
docker compose restart worker

# Durdur
docker compose down

# Smoke test
npm run smoke:api
```

## Konteyner Yapısı

| Servis | Konteyner | Görev | Durum |
|---|---|---|---|
| `api` | bcms_api | HTTP, Swagger, health — worker yok | `healthy` |
| `worker` | bcms_worker | ingest, notifications consumer, audit retention/partition, **outbox-poller** (PR-C1 — `OUTBOX_POLLER_ENABLED` env-gated) | Healthcheck disabled — worker HTTP sunucusu çalıştırmaz |
| `opta-watcher` | bcms_opta_watcher | SMB → /api/v1/opta/sync, state `/data` volume | `healthy` |
| `web` | bcms_web | Angular (nginx) | `healthy` |
| `postgres` | bcms_postgres | PostgreSQL 16 | — |
| `rabbitmq` | bcms_rabbitmq | RabbitMQ 3.12 | — |
| `keycloak` | bcms_keycloak | Auth | — |
| `prometheus` | bcms_prometheus | Metrikler | — |
| `grafana` | bcms_grafana | Dashboard | — |
| `mailhog` | bcms_mailhog | SMTP (dev) | — |
| `postgres_backup` | bcms_postgres_backup | pg_dump cron (03:00) + retention | localhost:8080 wget |

> **Worker Health (2026-04-30)**: Worker HTTP port açmadığı için Docker Compose worker healthcheck'i devre dışıdır. Worker durumu `docker compose logs -f worker`, consumer başlangıç logları ve audit retention job logları ile kontrol edilir.

> **Runtime Audit v2 (2026-04-30)**: `bcms_web`, `bcms_keycloak`, `bcms_api` ve `bcms_opta_watcher` healthy doğrulandı. Web ve Keycloak dış erişim için yeniden `0.0.0.0` port binding kullanır; API ve veri servisleri localhost'a kapalı kalır.

> **Stabilizasyon fazı (2026-04-30)**: Studio Plan race condition kapatıldı (`debounceTime(400)` + `switchMap`), audit retention job eklendi, API/worker Prisma pool limitleri ayarlandı, production `as any` cast'leri temizlendi ve web testleri `25/25 SUCCESS` geçti.

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

Örnek yanıt (OPTA kopuk):
```json
{ "status": "degraded", "checks": { "database": "ok", "rabbitmq": "ok", "opta": "degraded" } }
```

> **Not:** Degraded durumda HTTP **503** döner. Monitoring araçları 503'ü alarm tetikleyici olarak kullanabilir.

## Adresler

- Web: `http://172.28.204.133:4200`
- API: `http://127.0.0.1:3000` (host-local; LAN istemcileri web nginx `/api` proxy kullanır)
- Swagger: `http://172.28.204.133:4200/docs`
- Keycloak: `http://172.28.204.133:8080`
- RabbitMQ UI: `http://localhost:15673`
- Grafana: `http://localhost:3001`
- Prometheus: `http://localhost:9090`
- Mailhog UI: `http://localhost:8025`

## Grup Tabanlı Erişim Özeti

| Sekme / Özellik | Erişim |
|---|---|
| Yayın Planı (liste) | Tüm authenticated |
| Yayın Planı aksiyonları | Admin, SystemEng ve ilgili operasyon grupları (`Tekyon`, `Transmisyon`, `Booking`, `YayınPlanlama`) |
| Sorun Bildir butonu | Admin, SystemEng, Tekyon, Transmisyon |
| Raporlama | SystemEng |
| Stüdyo Planı (görüntüle) | Tüm authenticated |
| Stüdyo Planı (düzenle) | Admin, SystemEng, StudyoSefi |
| Ekip İş Takip | Her grup kendi işleri; Admin tüm gruplar (SystemEng kendi grubu) |
| Haftalık Shift | Her grup kendi shifti; supervisor kendi grubunu düzenler; Admin tüm gruplar (SystemEng kendi grubu) |
| Ingest | Admin, SystemEng, Ingest |
| MCR | Admin, SystemEng, MCR |
| Provys, Kanallar, Monitoring | Admin, SystemEng |
| Kullanıcılar, Ayarlar | Admin, SystemEng |

**Not:** `Günlük Yayın Raporu` sekmesi kaldırılmıştır. Raporlama `/schedules/reporting` üzerinden erişilir.

## Frontend Operasyon Sekmeleri

- `Canlı Yayın Plan Listesi` → `/schedules` (üst düzey öğe, tüm authenticated)
- `Raporlama` → `/schedules/reporting` — **bağımsız** navigasyon öğesi, rapor tipi seçilebilir:
  - `Canlı Yayın Planı` — tarih aralığı veya lig/hafta filtresi, Excel + PDF export
  - `Stüdyo Kullanım Raporu` — tarih aralığı filtresi, Excel + PDF export (TOPLAM satırı)
  - `Ingest` — tarih aralığı filtresi, Excel + PDF export (TOPLAM satırı)
- `Stüdyo Planı` → `/studio-plan` (`StudyoSefi` düzenler; `Admin` auto-bypass; diğerleri — `SystemEng` dahil — sadece liste görür)
- `Ekip İş Takip` → `/bookings` (kullanıcı kendi grubu; `Admin` tüm gruplar; `SystemEng` kendi grubu)
- `Haftalık Shift` → `/weekly-shift` (kullanıcı kendi grubu; supervisor kendi grubunu düzenler; `Admin` tüm gruplar; `SystemEng` kendi grubu)
- `Ingest Planlama` → `/ingest` (plan tab + port görünümü tab) — `Ingest`; `Admin` auto-bypass — `SystemEng` OUT
- `MCR` → `/mcr` — `MCR`; `Admin` auto-bypass — `SystemEng` OUT
- `Provys İçerik Kontrol` → `/provys-content-control` — `Admin` only — `SystemEng` OUT
- `Kanallar` → `/channels` — `Admin` only — `SystemEng` OUT
- `Monitoring` → `/monitoring` — `Admin` only — `SystemEng` OUT
- `Kullanıcılar` → `/users` — `SystemEng`; `Admin` auto-bypass
- `Ayarlar` → `/settings` — `SystemEng`; `Admin` auto-bypass

## Frontend Build / Görsel Notları

- `bcms_web` nginx ile statik Angular bundle sunar. Local `npm run build -w apps/web` tek başına çalışan Docker web servisini güncellemez.
- Frontend değişikliğinden sonra:
  ```bash
  docker compose up -d --build web
  ```
- Kullanıcı hâlâ eski görünümü görüyorsa tarayıcıda `Ctrl+Shift+R` hard refresh yapılmalıdır.
- Stüdyo Planı `Export PDF`, ana uygulama layout'unu yazdırmaz; `#studio-plan-export` alanını ayrı print penceresine klonlar. Print ölçüsü A3 landscape, `margin: 0`.
- Canlı Yayın Planı tablo gövdesinde başlıklar hariç veri hücreleri büyük ve kalın yazı kullanır; aksiyon ikonları büyütme dışında tutulur.
- Siteye LAN'dan ulaşılamıyorsa önce `docker compose ps web keycloak` çıktısında `0.0.0.0:4200->80` ve `0.0.0.0:8080->8080` port binding'lerini doğrula.

## Ekip İş Takip (Booking / Work Tracking) — 2026-04-29

- Konum: `Ekip İş Takip` navigasyon öğesi
- Tablo görünümü (mat-table): İş Başlığı, Grup, Oluşturan, Durum, Tarih, Sorumlu, Aksiyonlar
- Durumlar: `PENDING` (Açık), `APPROVED` (Tamamlandı), `REJECTED` (Reddedildi), `CANCELLED` (İptal)
- Sıralama: Açık (PENDING) işler yukarıda, sonra tarihe göre
- Dialog: `BookingTaskDialogComponent` — İş Başlığı, Grup, Başlama/Tamamlanma, Sorumlu, Durum, Detaylar, Rapor
- Yetki: Her kullanıcı kendi grubunun işlerini görür ve iş oluşturabilir. Grup `supervisor` kullanıcısı sorumlu atayabilir; işi oluşturan veya sorumlu kişi silebilir. `Admin` `isAdminPrincipal` ile auto-bypass — tüm gruplarda tam yetkili. Diğer gruplar `rbac.ts` PERMISSIONS map'ine göre kapsamlandırılmıştır (SystemEng dahil).

## Haftalık Shift (Weekly Shift) — 2026-04-29

- Konum: `Haftalık Shift` navigasyon öğesi
- Haftalık tablo (Pzt-Paz), her hücrede izin veya saat bilgisi
- İzin tipleri: `OFF_DAY`, `HOME`, `OUTSIDE`, `NIGHT`, `SIC_CER`, `HOLIDAY`, `ANNUAL`
- Giriş saatleri: `05:00`, `06:00`, `07:45`, `10:00`, `12:00`, `14:45`, `16:30`, `23:30`
- Excel/PDF export: Renkli hücreler, zebra striping
- Çıkış saatleri: `06:15`, `13:15`, `15:00`, `16:45`, `20:00`, `22:00`, `23:45`
- Kural: izin ve saat bilgisi aynı hücrede birlikte seçilemez.
- Yetki: kullanıcı kendi grubunu görür; grup `supervisor` kullanıcısı kendi grubunu düzenler; `Admin` `isAdminPrincipal` ile auto-bypass — tüm gruplarda tam yetkili. Diğer gruplar `rbac.ts` PERMISSIONS map'ine göre (SystemEng dahil).

## Ingest Operasyon Mimarisi

- `worker` konteyneri ingest-worker ve ingest-watcher'ı çalıştırır.
- Kayıt port katalogu: `recording_ports` (varsayılan 1-44 + Metus1/Metus2 = 46 port).
- Plan kalıcılığı: `ingest_plan_items`.
- Port çakışması backend'de reddedilir; DB tarafındaki exclusion constraint ek güvence sağlar.
- Plan item saatlerinde başlangıç bitişten küçük olmak zorundadır.
- Saat düzenleme: tüm kaynak tipler (live/studio/ingest-plan), 5 dk adımlı.
- Burst polling: 6×10 sn.
- Port Görünümü tam ekran modunda tüm viewport'a yerleşir; başlık sabit, pano alanı kalan yüksekliği kullanır.

## OPTA SMB Watcher

- Konteyner: `bcms_opta_watcher` (Python, `scripts/opta_smb_watcher.py`)
- Ağ: Docker bridge (`bcms_net`) → API'ye `http://api:3000/api/v1` üzerinden erişir
- SMB'de değişen her `srml-*-results.xml` dosyası taranır; `POST /api/v1/opta/sync` ile senkronize edilir
- **Kimlik doğrulama**: timing-safe `Authorization: Bearer <OPTA_WATCHER_API_TOKEN>`
- `/api/v1/opta/sync` rate limit dışındadır.
- `MTIME_SETTLE_SEC=5`, `BATCH_SIZE=100`
- XML parse için `defusedxml.ElementTree` kullanılır.
- Watcher state kalıcı named volume ile `/data` altında tutulur; container restart sonrası state kaybı beklenmez.
- Container env içinde `HOME=/data` olmalıdır; state dosyası `/data/.bcms-opta-watcher-state.json` altında kalır.
- Healthcheck `procps/pgrep` bağımlılığıyla çalışır; image değişirse `bcms_opta_watcher` health durumunu ayrıca kontrol et.
- API sync endpoint lig ve maç yazımlarını tek Prisma transaction içinde yapar.

```bash
docker compose logs -f opta-watcher
docker compose restart opta-watcher
```

## Outbox + DLQ V1 (2026-05-06)

Tüm domain event'leri `outbox_events` tablosuna **Phase 2 shadow** olarak yazılır (status='published'). Direct publish (queue.X) hâlâ aktif; poller henüz authoritative değil. PR-C2 cut-over (shadow→pending + direct publish disable) production soak gate'e bağlı.

### Background service

`worker` container'ında `outbox-poller` registered. Default disabled — `OUTBOX_POLLER_ENABLED=true` env ile aktive edilir:

```bash
# .env veya docker-compose.override.yml içinde:
OUTBOX_POLLER_ENABLED=true   # PR-C1 deploy + soak için
OUTBOX_POLLER_DRY_RUN=false  # default; pick + log + publish + status update
```

### Smoke check

```bash
node ops/scripts/check-outbox-cutover.mjs --phase=pre   # PR-C2 öncesi
node ops/scripts/check-outbox-cutover.mjs --phase=post  # cut-over sonrası
node ops/scripts/check-outbox-cutover.mjs --phase=pre --json   # CI/automation
```

Pre kontrolleri: `event_type` breakdown + `idempotency_key` duplicate yok + `pending=0` (Phase 2 invariant).
Post kontrolleri: `failed=0` + `dead=0` + `pending_lag` ≤30s.

### Manuel SQL

```sql
-- Status breakdown
SELECT status, COUNT(*) FROM outbox_events GROUP BY status;

-- Failed/dead drill-down
SELECT id, event_type, attempts, last_error, next_attempt_at
FROM outbox_events WHERE status IN ('failed', 'dead')
ORDER BY id DESC LIMIT 20;
```

### Rollback

`ops/RUNBOOK-OUTBOX-POLLER-CUTOVER.md` §4: 3 katman (soft env / hard revert / nuclear).

### Tasarım docs

- `ops/REQUIREMENTS-OUTBOX-DLQ-V1.md` — üst tasarım
- `ops/REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md` — Phase 3 cut-over plan (PR-C)
- `ops/REQUIREMENTS-OUTBOX-PR-D-V1.md` — replay/retention/cleanup (PR-D)
- `ops/DECISION-INGEST_COMPLETED-AUTHORITATIVE-PRODUCER.md` — sub-option B2 (idempotency_key)

## Canli Yayin Plani Kapsami (post-B5a Block 2)

`schedules.usage_scope` discriminator kolonu **artık YOK** (SCHED-B5a Block 2 migration `20260510120000_sched_b5a_block2_drop_legacy`, 2026-05-10). İki ayrı canonical domain var:

```text
Schedule (broadcast flow)
  → schedules tablosu, event_key IS NOT NULL satırlar
  → structured alanlar: event_key + schedule_date/time + channel_1/2/3_id + 3 lookup option
  → hard-delete (deleted_at da DROP edildi)

Live-plan (event + operasyon + teknik detay)
  → live_plan_entries (1:1 ile event)
  → live_plan_technical_details (M5-B7 sırada, ~80 prefix'li kolon)
  → live_plan_transmission_segments (M5-B8)
  → 25 lookup tablo + /api/v1/live-plan/lookups/:type generic CRUD (M5-B5 done)
  → soft-delete (deleted_at) korunur
```

> **Madde 5 (durum 2026-05-10)**: K15 prensibi — JSON canonical YOK; live-plan teknik detayları structured DB kolon/lookup FK. PERMISSIONS namespace'leri: `livePlan` (entity CRUD) + `livePlanLookups` (master data — read all-auth, write/delete SystemEng+Admin). Strangler durum: M5-B1..B6 done (schema + service/API + K15 mapping + lookup foundation + lookup management API + **Lookup Admin UI**); M5-B7..B8 backend done (technical_details + transmission_segments schema + nested API); M5-B10a UI scaffold done; **sıradaki M5-B10b (76 alanlı technical-details form)** → B11..B14. Detay: `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` + `ops/REQUIREMENTS-LIVE-PLAN-TECHNICAL-FIELDS-V1.md` + `ops/REQUIREMENTS-SCHEDULE-CLEANUP-V1.md`.

> **B5b'ye kalan legacy schedule kolonları**: `schedules.metadata`, `start_time`, `end_time` (reporting `/schedules/reporting` bağımlı); `channel_id` + `Schedule.channel` relation (Playout/MCR coupling, Y5-8 follow-up). Yeni kod bu alanlara bağlanmasın.

## Web / Frontend

Angular production build `environment.prod.ts` kullanmalıdır (`skipAuth: false`).

**"dev-admin" görünüyorsa veya tüm API çağrıları 401 dönüyorsa:**
```bash
docker compose up -d --build web
```

Keycloak oturumu Docker restart sonrası geçersiz kalır. Tarayıcıda hard refresh (Ctrl+Shift+R) yapıp yeniden login olunmalıdır.

### Oturum Yenileme — 2026-04-30

- Web uygulaması açık kaldığı sürece Keycloak token periyodik yenilenir.
- Her API çağrısından önce token minimum 60 saniye geçerli olacak şekilde refresh edilir.
- Kullanıcı `Çıkış yap` butonuna basmadıkça frontend logout zorlamaz.
- Keycloak container restart edilirse veya realm max session policy aşılırsa yeniden login gerekir.

## LAN / Ağ Erişimi (Farklı Bilgisayardan)

`http://172.28.204.133:4200` adresine başka bir PC'den bağlanmak için iki yapılandırma:

### 1. Keycloak redirect_uri
`bcms-web` client'ına LAN IP eklenmiştir (`infra/keycloak/realm-export.json`).

### 2. Token Issuer (Çoklu Issuer Desteği)
`KEYCLOAK_ALLOWED_ISSUERS=http://172.28.204.133:8080/realms/bcms,http://localhost:8080/realms/bcms`

### 3. Canlı realm güvenliği
Startup import mevcut realm'i overwrite etmez. Çalışan realm'e `sslRequired=external` uygulamak için:

```bash
ops/scripts/bcms-keycloak-apply-security.sh
```

## Güvenlik

### API Rate Limiting
API global olarak dakikada **300 istek** sınırına tabidir.
- Muaf endpoint'ler: `/health`, `/metrics`, `/api/v1/ingest/callback`, `/api/v1/opta/sync`

### Docker HEALTHCHECK
`api` ve `web` container'ları Docker health check kullanıyor:
```bash
docker inspect bcms_api --format='{{.State.Health.Status}}'
docker inspect bcms_web --format='{{.State.Health.Status}}'
```

### Port Erişim Kısıtlaması
| Servis | Port | Erişim |
|---|---|---|
| API | **127.0.0.1**:3000 | Sadece localhost |
| Web | **0.0.0.0**:4200 | LAN erişimi açık |
| Keycloak | **0.0.0.0**:8080 | LAN erişimi açık |
| PostgreSQL | **127.0.0.1**:5433 | Sadece localhost |
| RabbitMQ AMQP | **127.0.0.1**:5673 | Sadece localhost |
| RabbitMQ UI | **127.0.0.1**:15673 | Sadece localhost |
| Prometheus | **127.0.0.1**:9090 | Sadece localhost |
| Grafana | **127.0.0.1**:3001 | Sadece localhost |
| MailHog | **127.0.0.1**:8025 | Sadece localhost |

## Kalan Operasyon Riskleri — 2026-04-30

- Stüdyo Planı save race condition kapatıldı; hızlı hücre değişimleri son state üzerinden kaydedilir.
- `audit_logs` tablosu için retention job açık kalmalı ve `AUDIT_RETENTION_DAYS` izlenmeli.
- Büyük frontend component'lerde test kapsamı başladı; edge case ve error path testleri genişletilmeli.
- `npm audit` high/critical göstermiyor, ancak 7 moderate vulnerability ayrı branch'te dry-run ve build/test ile ele alınmalı.

## Prisma Connection Pool — 2026-04-30

- API (`BCMS_BACKGROUND_SERVICES=none`): `connection_limit=10`
- Worker (`BCMS_BACKGROUND_SERVICES!=none`): `connection_limit=5`
- Her iki runtime: `pool_timeout=20`
- Uygulama noktası: `apps/api/src/plugins/prisma.ts` → `buildDatabaseUrl()`.

Uzaktan erişim için SSH tüneli:
```bash
ssh -L 15673:localhost:15673 ubuntu@172.28.204.133
```

### nginx Güvenlik Header'ları
`infra/docker/nginx.conf` — 6 güvenlik header'ı.
Web imajı rebuild gerekir: `docker compose up -d --build web`

## Aktif Ops Scriptleri

```text
ops/scripts/bcms-build.sh           → packages/shared + api + web build
ops/scripts/bcms-restart.sh         → build + servis restart
ops/scripts/bcms-status.sh          → docker compose ps
ops/scripts/bcms-logs.sh            → docker compose logs
ops/scripts/bcms-opta-status.sh     → OPTA bağlantı durumu
ops/scripts/bcms-keycloak-apply-security.sh → canlı Keycloak realm sslRequired=external uygular
ops/scripts/bcms-smoke-api.mjs      → API smoke test
```

## Veritabanı

```bash
# Migration (local DB açıkken)
npm run db:migrate:prod -w apps/api

# Prisma Studio
npm run db:studio -w apps/api
```

2026-04-29 integrity migration:
- `schedules_no_channel_time_overlap`: aynı kanal için CANCELLED olmayan yayınların zaman aralığı çakışamaz.
- `incidents_open_signal_loss_channel_uidx`: aynı kanal için tek açık `SIGNAL_LOSS` incident bulunabilir.

2026-04-30 reconcile migration (`20260430000000_reconcile_cascades_and_enums`):
- `ScheduleStatus` enum'u `schedule_status` olarak yeniden adlandırıldı; diğer enum'larla snake_case naming uyumu sağlandı.
- `teams`, `matches`, `ingest_plan_items`, `qc_reports` foreign key'leri `ON DELETE CASCADE` davranışı ile yeniden oluşturuldu.
- `prisma migrate diff` boş çıktı verir → DB ve schema eşleşiyor.

2026-04-30 obsolete-keys cleanup (`20260430130000_strip_obsolete_live_detail_keys`):
- Tahta/Kaynak ve Yedek Kaynak Teknik Detay'dan kaldırıldı; defansif idempotent jsonb minus ile 16 obsolete key (`upConverter, offTubeResource, recordLocation3, hdvgResource, intercom, dailyReportShortNotes` + 10 backup* key'i) `metadata.liveDetails`'den strip edildi.
- Pre-check: 110 schedule, 0 etkilenen (key'ler zaten yoktu). Post-check: 0 obsolete key kaldı.

2026-04-30 normalize recording ports (`20260430140000_normalize_recording_ports`):
- Yeni `ingest_plan_item_ports` tablosu: plan_item_id (FK CASCADE), port_name, role∈{primary,backup}, denormalized day_date+planned_start/end_minute. Tek GiST exclusion constraint cross-role overlap'i DB-level garanti eder. UNIQUE(plan_item_id,role) + UNIQUE(plan_item_id,port_name).
- Mevcut 48+ ingest_plan_items.recording_port satırı role='primary' ile yeni tabloya migrate edildi.
- Eski `no_port_time_overlap` exclusion + `recording_port` kolonu drop.
- Defansif `metadata.liveDetails.recordLocation` strip de aynı migration'da (zaten 0 doluydu).

## Yedekleme & Restore

```bash
# Manuel backup tetikle
docker exec bcms_postgres_backup /backup.sh

# Backup health
docker exec bcms_postgres_backup wget -qO- http://localhost:8080
# Beklenen: "OK"

# Mevcut dump'ları listele
ls -lh infra/postgres/backups/last/
ls -lh infra/postgres/backups/daily/ | tail -10
```

Restore prosedürü (single DB / Keycloak / full disaster) — `infra/postgres/RESTORE.md`.

**Önemli quirk**: Image v0.0.11 wrapper compression yapmıyor; `.sql.gz` uzantılı dosyalar plain SQL. Restore'da `cat` (gunzip değil) kullanılır:

```bash
cat infra/postgres/backups/last/bcms-latest.sql.gz | \
  docker exec -i bcms_postgres psql -U bcms_user -d bcms
```

**Restore drill (2026-04-30)**: Scratch DB'ye restore → kaynak DB ile schedules count match (110 → 110). Drill başarılı.

**Off-host kopya yok**: Mevcut sidecar tek host'ta. Disk arızasında kaybolur — follow-up olarak rsync/S3/borg ekleme RESTORE.md'de listeli.

## RabbitMQ Publisher Confirms (2026-04-30)

`apps/api/src/plugins/rabbitmq.ts` `createConfirmChannel()` kullanır. `publish()` Promise-wrapped `sendToQueue` ile broker ack bekler. Bağlantı yokken `throw` eder (silent drop yok). Caller'lar bu nedenle `try/catch` ile sarmalı veya hata propagate edileceğini kabul etmeli.

Hızlı doğrulama:
```bash
docker logs bcms_api 2>&1 | grep "RabbitMQ connected"
docker logs bcms_worker 2>&1 | grep -E "RabbitMQ connected|Notification consumer"
```

## OPTA Cascade — Match Date Değişimi (2026-05-01)

`POST /api/v1/opta/sync` endpoint'i artık **schedule cascade** içerir. Match'in `matchDate`'i değiştiğinde, o maça bağlı tüm canlı yayın schedule'lar (orijinal + duplicate'lar — `metadata.optaMatchId` üzerinden) delta-based shift edilir.

**Davranış:**
- Status `COMPLETED`/`CANCELLED`/`ON_AIR` olan schedule'lar dokunulmaz (FROZEN_STATUSES)
- Top-level `startTime`/`endTime` += delta (duration korunur)
- Metadata `transStart`/`transEnd` (HH:MM string) += delta (24h wrap, range check < 24:< 60)
- Version optimistic lock — eş zamanlı user edit varsa cascade skip
- Channel-overlap exclusion fire ederse o schedule skip
- Cascade outer try/catch — hiçbir hata response'u patlatmaz
- RabbitMQ `SCHEDULE_UPDATED` event publish (source: 'opta-cascade')
- Payload dedupe: aynı `matchUid` 2× gelirse Map ile tekilleştirilir

**Response shape:**
```json
{
  "inserted": 0, "updated": 1, "unchanged": 0,
  "cascadedSchedules": 7, "cascadeConflicts": 0,
  "manualReconcileRequired": false,
  "cascadeError": null
}
```

**⚠ Drift riski:** `manualReconcileRequired:true` ise (cascadeConflicts>0 veya cascadeError !=null) o schedule kalıcı drift'te kalır. Sonraki OPTA sync'i `unchanged` görür → cascade tetiklenmez. Manuel reconcile veya drift scan follow-up PR ile çözülür. Logs'ta scheduleId/matchUid/delta açık.

Hızlı test:
```bash
# Bir maçı +60dk shift et, cascade gerçekleştiğini doğrula
curl -X POST http://127.0.0.1:3000/api/v1/opta/sync \
  -H "Authorization: Bearer $OPTA_SYNC_SECRET" -H "Content-Type: application/json" \
  -d '{"matches":[{"matchUid":"...","compId":"...","matchDate":"2026-05-01T18:00:00.000Z","season":"2026"}]}'
```

## RBAC Yeniden Yapılandırma — SystemEng Demotion (2026-05-01 geç saat)

**Karar**: Tek "full yetki" grubu Admin. SystemEng "ops super-grubu" davranışından çıkarıldı.

**Admin için 4 katman centralized bypass**:
- Backend `auth.ts requireGroup` (~satır 109) — `isAdminPrincipal` early return → tüm requireGroup-protected endpoint'leri bypass
- Frontend `auth.guard.ts:44` — `userGroups.includes(GROUP.Admin)` early return → tüm route guard'ları bypass
- Frontend `app.component.ts visibleNavItems` — `isAdmin = groups.includes(GROUP.Admin)` filter bypass → tüm nav item'ları görür
- Frontend `schedule-list.component.ts hasGroup()` (line ~37) — Admin için early return true → tüm canEdit/canAdd/canDelete butonları açık

**Eski "Admin → SystemEng auto-augment" mekanizması (2026-05-01 commit `0220b3e` ile KALDIRILDI)**: önceki sürümde `auth.ts:101-103` ve `app.component.ts:161` Admin token'ına SystemEng eklerdi. Eski "Admin = ops super-grup" modelin kalıntısıydı. Yeni RBAC ile çakıştığı için temizlendi.

**SystemEng PERMISSIONS değişiklikleri**:
- schedules.{add,edit,technicalEdit,duplicate,delete,write}: SystemEng OUT
- studioPlans.{write,delete}: SystemEng OUT (sadece StudyoSefi)
- reports.{read,export}: ['Admin'] (gizli)
- weeklyShifts.admin: ['Admin'] (kendi grubu görür)
- ingest.{read,write,delete}: SystemEng OUT (sadece Ingest grup)
- monitoring.{read,write}: ['Admin']
- channels.{read,write,delete}: ['Admin']

**Korunan SystemEng yetkileri**:
- auditLogs.read, incidents.{read,write,delete}, incidents.reportIssue
- /users, /settings, /audit-logs, /documents route data + nav

**Frontend kalıntı temizliği**:
- `STUDIO_EDIT_GROUPS` (studio-plan.component.ts:111): SystemEng → Admin only kalır
- `/schedules/reporting` route guard (schedules.routes.ts:13-18): `[GROUP.Admin]`
- `booking-list.component.ts isAdmin` (line 426): Admin only
- `booking.service.ts isSistemMuhendisligi` → `isAdminUser` (rename + claims.groups.includes('Admin'))

**Doğrulama** (canlı, node REPL):
```js
PERMISSIONS.schedules.add.includes('SystemEng')      // false
PERMISSIONS.studioPlans.write.includes('SystemEng')  // false
PERMISSIONS.reports.read.includes('SystemEng')       // false
PERMISSIONS.channels.read.includes('SystemEng')      // false
PERMISSIONS.ingest.read.includes('SystemEng')        // false
PERMISSIONS.monitoring.read.includes('SystemEng')    // false
PERMISSIONS.auditLogs.read.includes('SystemEng')     // true (korunan)
PERMISSIONS.incidents.read.includes('SystemEng')     // true (korunan)
```

**Admin gap audit**:
4 ana centralized bypass + 3 manuel grup kontrol noktası (`users.routes.ts:47`, `booking.service.ts isAdminUser`, `weekly-shifts hasAnyGroup`) tek tek kontrol edildi — Admin user her endpoint, route, UI button'a erişiyor. **Auto-augment kalıntısı kaldırıldı**, Admin yetkisi artık tek bir tutarlı pattern üzerinden sağlanıyor.

## Auth Interceptor — 403 Reload Loop Fix (2026-05-01)

**Sebep**: önceki sürümde catchError HTTP error (401/403) ile token error ayırt etmiyordu. Tekyon group user `/channels` 403 alınca → `keycloak.login()` → reload → ngOnInit → 403 → reload → sonsuz loop.

**Fix**:
- HTTP error → propagate (REDIRECT YOK)
- Token-fetch / Keycloak-instance hatası → throttle'lı redirect (sessionStorage 30sn)

Belirti tespiti:
```bash
docker logs --tail 100 bcms_api 2>&1 | grep -c "incoming request"
# Eğer 1 saniyede 2× /channels + /schedules pattern görünüyorsa loop signature
```

Prisma Client generate sorunu:
```bash
rm -rf node_modules/.prisma node_modules/@prisma/client node_modules/prisma
npm install prisma@5.22.0 @prisma/client@5.22.0
npm run db:generate -w apps/api
```
