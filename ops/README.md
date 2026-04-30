# BCMS Operasyon — Docker Compose

> Son güncelleme: 2026-04-30 — Stabilizasyon fazı tamamlandı: Studio Plan save flow, audit retention, DB connection tuning, production typing cleanup ve test doğrulamaları güncellendi.

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
| `worker` | bcms_worker | ingest, bxf, notifications consumer, audit retention | Healthcheck disabled — worker HTTP sunucusu çalıştırmaz |
| `opta-watcher` | bcms_opta_watcher | SMB → /api/v1/opta/sync, state `/data` volume | `healthy` |
| `web` | bcms_web | Angular (nginx) | `healthy` |
| `postgres` | bcms_postgres | PostgreSQL 16 | — |
| `rabbitmq` | bcms_rabbitmq | RabbitMQ 3.12 | — |
| `keycloak` | bcms_keycloak | Auth | — |
| `prometheus` | bcms_prometheus | Metrikler | — |
| `grafana` | bcms_grafana | Dashboard | — |
| `mailhog` | bcms_mailhog | SMTP (dev) | — |

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
| Ekip İş Takip | Her grup kendi işleri; Admin/SystemEng tüm gruplar |
| Haftalık Shift | Her grup kendi shifti; supervisor kendi grubunu düzenler; Admin/SystemEng tüm gruplar |
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
- `Stüdyo Planı` → `/studio-plan` (`StudyoSefi`, `SystemEng`, `Admin` düzenler; diğerleri liste görür)
- `Ekip İş Takip` → `/bookings` (kullanıcı kendi grubu, `Admin`/`SystemEng` tüm gruplar)
- `Haftalık Shift` → `/weekly-shift` (kullanıcı kendi grubu, supervisor düzenler, `Admin`/`SystemEng` tüm gruplar)
- `Ingest Planlama` → `/ingest` (plan tab + port görünümü tab) — `SystemEng`, `Admin`, `Ingest`
- `MCR` → `/mcr` — `SystemEng`, `Admin`, `MCR`
- `Provys İçerik Kontrol` → `/provys-content-control` — `SystemEng`, `Admin`
- `Kanallar` → `/channels` — `SystemEng`, `Admin`
- `Monitoring` → `/monitoring` — `SystemEng`, `Admin`
- `Kullanıcılar` → `/users` — `SystemEng`, `Admin`
- `Ayarlar` → `/settings` — `SystemEng`, `Admin`

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
- Yetki: Her kullanıcı kendi grubunun işlerini görür ve iş oluşturabilir. Grup `supervisor` kullanıcısı sorumlu atayabilir; işi oluşturan veya sorumlu kişi silebilir. `Admin`/`SystemEng` tüm gruplarda tam yetkilidir.

## Haftalık Shift (Weekly Shift) — 2026-04-29

- Konum: `Haftalık Shift` navigasyon öğesi
- Haftalık tablo (Pzt-Paz), her hücrede izin veya saat bilgisi
- İzin tipleri: `OFF_DAY`, `HOME`, `OUTSIDE`, `NIGHT`, `SIC_CER`, `HOLIDAY`, `ANNUAL`
- Giriş saatleri: `05:00`, `06:00`, `07:45`, `10:00`, `12:00`, `14:45`, `16:30`, `23:30`
- Excel/PDF export: Renkli hücreler, zebra striping
- Çıkış saatleri: `06:15`, `13:15`, `15:00`, `16:45`, `20:00`, `22:00`, `23:45`
- Kural: izin ve saat bilgisi aynı hücrede birlikte seçilemez.
- Yetki: kullanıcı kendi grubunu görür; grup `supervisor` kullanıcısı kendi grubunu düzenler; `Admin`/`SystemEng` tüm gruplarda tam yetkilidir.

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

## Canli Yayin Plani Kapsami

```text
schedules.usage_scope = 'live-plan'   → Sadece Raporlama + Ingest
schedules.usage_scope = 'broadcast'  → Normal yayın
```

## Web / Frontend

Angular production build `environment.prod.ts` kullanmalıdır (`skipAuth: false`).

**"dev-admin" görünüyorsa veya tüm API çağrıları 401 dönüyorsa:**
```bash
docker compose up -d --build web
```

Keycloak oturumu Docker restart sonrası geçersiz kalır. Tarayıcıda hard refresh (Ctrl+Shift+R) yapıp yeniden login olunmalıdır.

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

Prisma Client generate sorunu:
```bash
rm -rf node_modules/.prisma node_modules/@prisma/client node_modules/prisma
npm install prisma@5.22.0 @prisma/client@5.22.0
npm run db:generate -w apps/api
```
