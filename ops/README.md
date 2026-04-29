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

| Servis | Konteyner | Görev | Durum |
|---|---|---|---|
| `api` | bcms_api | HTTP, Swagger, health — worker yok | `healthy` |
| `worker` | bcms_worker | ingest, bxf, notifications consumer | **⚠️ `unhealthy`** — HTTP health check çalışmıyor (worker HTTP sunucusu çalıştırmaz) |
| `opta-watcher` | bcms_opta_watcher | SMB → /api/v1/opta/sync | — |
| `web` | bcms_web | Angular (nginx) | `healthy` |
| `postgres` | bcms_postgres | PostgreSQL 16 | — |
| `rabbitmq` | bcms_rabbitmq | RabbitMQ 3.12 | — |
| `keycloak` | bcms_keycloak | Auth | — |
| `prometheus` | bcms_prometheus | Metrikler | — |
| `grafana` | bcms_grafana | Dashboard | — |
| `mailhog` | bcms_mailhog | SMTP (dev) | — |

> **Worker Health Check Sorunu (2026-04-29)**: `bcms_worker` container'ı `curl http://localhost:3000/health` ile health check yapıyor ama worker HTTP sunucusu çalıştırmaz. Docker Compose'ta worker health check kaldırılmalı veya worker'a RabbitMQ bağlantı kontrolü eklenmeli. Bu, fonksiyonel bir sorun değildir — worker normal çalışır.

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
- API: `http://172.28.204.133:3000`
- Swagger: `http://172.28.204.133:4200/docs`
- RabbitMQ UI: `http://localhost:15673`
- Grafana: `http://localhost:3001`
- Prometheus: `http://localhost:9090`
- Mailhog UI: `http://localhost:8025`

## Grup Tabanlı Erişim Özeti

| Sekme / Özellik | Erişim |
|---|---|
| Yayın Planı (liste) | Tüm authenticated |
| Sorun Bildir butonu | Sistem Muhendisligi, Yayın Muhendisligi, Transmisyon |
| Raporlama | Tüm authenticated |
| Stüdyo Planı (görüntüle) | Tüm authenticated |
| Stüdyo Planı (düzenle) | Sistem Muhendisligi, Studyo Sefligi |
| Ekip İş Takip | Sistem Muhendisligi |
| Haftalık Shift | Sistem Muhendisligi |
| Ingest | Sistem Muhendisligi, Ingest |
| MCR | Sistem Muhendisligi, MCR |
| Rezervasyonlar | Sistem Muhendisligi |
| Provys, Kanallar, Monitoring | Sistem Muhendisligi |
| Kullanıcılar, Ayarlar | Sistem Muhendisligi |

**Not:** `Günlük Yayın Raporu` sekmesi kaldırılmıştır. Raporlama `/schedules/reporting` üzerinden erişilir.

## Frontend Operasyon Sekmeleri

- `Canlı Yayın Plan Listesi` → `/schedules` (üst düzey öğe, tüm authenticated)
- `Raporlama` → `/schedules/reporting` — **bağımsız** navigasyon öğesi, rapor tipi seçilebilir:
  - `Canlı Yayın Planı` — tarih aralığı veya lig/hafta filtresi, Excel + PDF export
  - `Stüdyo Kullanım Raporu` — tarih aralığı filtresi, Excel + PDF export (TOPLAM satırı)
  - `Ingest` — tarih aralığı filtresi, Excel + PDF export (TOPLAM satırı)
- `Stüdyo Planı` → `/studio-plan` (Studyo Sefligi+Sistem Muhendisligi düzenler; diğerleri liste görür)
- `Ekip İş Takip` → `/bookings` (Sistem Muhendisligi)
- `Haftalık Shift` → `/weekly-shift` (Sistem Muhendisligi)
- `Ingest Planlama` → `/ingest` (plan tab + port görünümü tab) — Sistem Muhendisligi + Ingest
- `MCR` → `/mcr` — Sistem Muhendisligi + MCR
- `Provys İçerik Kontrol` → `/provys-content-control` — Sistem Muhendisligi
- `Kanallar` → `/channels` — Sistem Muhendisligi
- `Monitoring` → `/monitoring` — Sistem Muhendisligi
- `Rezervasyonlar` → `/bookings` — Sistem Muhendisligi
- `Kullanıcılar` → `/users` — Sistem Muhendisligi
- `Ayarlar` → `/settings` — Sistem Muhendisligi

## Ekip İş Takip (Booking / Work Tracking) — 2026-04-29

- Konum: `Canlı Yayın Plan Listesi → Ekip İş Takip` sekmesi
- Tablo görünümü (mat-table): İş Başlığı, Grup, Oluşturan, Durum, Tarih, Sorumlu, Aksiyonlar
- Durumlar: `PENDING` (Açık), `APPROVED` (Tamamlandı), `REJECTED` (Reddedildi), `CANCELLED` (İptal)
- Sıralama: Açık (PENDING) işler yukarıda, sonra tarihe göre
- Dialog: `BookingTaskDialogComponent` — İş Başlığı, Grup, Başlama/Tamamlanma, Sorumlu, Durum, Detaylar, Rapor
- Yetki: Sadece `Sistem Muhendisligi`

## Haftalık Shift (Weekly Shift) — 2026-04-29

- Konum: `Haftalık Shift` navigasyon öğesi
- Haftalık tablo (Pzt-Paz), her hücrede vardiya tipi ve saat
- Vardiya tipleri: `OFF_DAY`, `HOME`, `OUTSIDE`, `NIGHT`, `SIC_CER`, `HOLIDAY`, `ANNUAL`
- Excel/PDF export: Renkli hücreler, zebra striping
- Bitiş saatleri: `06:15, 13:15, 15:00, 16:45, 20:00, 22:00, 23:45, Y.SONU`
- Yetki: Sadece `Sistem Muhendisligi`

## Ingest Operasyon Mimarisi

- `worker` konteyneri ingest-worker ve ingest-watcher'ı çalıştırır.
- Kayıt port katalogu: `recording_ports` (varsayılan 1-44 + Metus1/Metus2 = 46 port).
- Plan kalıcılığı: `ingest_plan_items`.
- Port çakışması backend'de reddedilir.
- Saat düzenleme: tüm kaynak tipler (live/studio/ingest-plan), 5 dk adımlı.
- Burst polling: 6×10 sn.

## OPTA SMB Watcher

- Konteyner: `bcms_opta_watcher` (Python, `scripts/opta_smb_watcher.py`)
- Ağ: `network_mode: host` → API'ye `http://localhost:3000/api/v1` üzerinden erişir
- SMB'de değişen her `srml-*-results.xml` dosyası taranır; `POST /api/v1/opta/sync` ile senkronize edilir
- **Kimlik doğrulama**: `Authorization: Bearer <OPTA_WATCHER_API_TOKEN>`
- `MTIME_SETTLE_SEC=5`, `BATCH_SIZE=100`

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

## Güvenlik

### API Rate Limiting
API global olarak dakikada **300 istek** sınırına tabidir.
- Muaf endpoint'ler: `/health` ve `/api/v1/ingest/callback`

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
| RabbitMQ AMQP | 5673 | Tüm arayüzler |
| RabbitMQ UI | **127.0.0.1**:15673 | Sadece localhost |
| Prometheus | **127.0.0.1**:9090 | Sadece localhost |
| Grafana | 3001 | Tüm arayüzler |

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
ops/scripts/bcms-smoke-api.mjs      → API smoke test
```

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
