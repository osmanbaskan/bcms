# BCMS Dokümantasyon — İçindekiler

> **BCMS** (Broadcast Content Management System) — beINport yayın operasyon platformu.
> Bu klasör: her UI sekmesi ve her arka plan worker/watcher için ayrı, geniş döküman.
> Oluşturma: 2026-06-03. Dil: Türkçe. Kaynak: kod tabanı (canlı doğrulama).

---

## Mimari özet (5 maddede)

1. **Frontend** — Angular 21 (standalone + signals), Material. Tek giriş **nginx (HTTPS :443)**;
   nginx statik SPA'yı sunar + `/api`'yi `api:3000`'e, `/realms` vb.'yi `keycloak:8080`'e proxy'ler.
2. **Backend** — Fastify 5 + Prisma 5 + PostgreSQL 16. İki container rolü:
   - **api** (`BCMS_BACKGROUND_SERVICES=none`) → yalnız HTTP/REST.
   - **worker** → 12 arka plan servisi (worker/watcher).
3. **Kimlik** — Keycloak (RS256 JWT). Yetki **gruplar** üzerinden (roller değil): 12 grup
   (`Admin, Tekyon, Transmisyon, Booking, YayınPlanlama, SystemEng, Ingest, Kurgu, MCR, PCR, Ses, StudyoSefi`).
   `Admin` tüm `requireGroup`'u bypass eder; `SystemEng` operasyonel süper-grup (ama bypass etmez, listelenir).
4. **Mesaj kuyruğu** — RabbitMQ (Docker, host portu 5673). Olay otobüsü: api olayı **outbox** tablosuna yazar,
   **outbox-poller** RabbitMQ'ya yayınlar, **notifications** consumer e-posta gönderir.
5. **Dış sistemler** — **OPTA** (maç verisi, Python watcher), **Avid Interplay/MediaCentral** (arşiv ara/restore/transfer),
   **Provys** (BXF playout playlist), **SSDB** (materyal/medya çözümleme).

### İki canonical domain (kafa karıştırıcı isimlendirme — DİKKAT)
- **"Canlı Yayın Plan" sekmesi** (route `/schedules`) aslında **`live_plan_entries`** tablosunu yönetir.
- **"Yayın Planlama" sekmesi** (route `/yayin-planlama`) aslında **`schedules`** tablosunu oluşturur.
- Yani **ekran adları ile DB tablo adları terstir.** Detay: [`sekmeler/canli-yayin-plan.md`](sekmeler/canli-yayin-plan.md), [`sekmeler/yayin-planlama.md`](sekmeler/yayin-planlama.md).

---

## Sekmeler (UI)

### OPERASYON
| Sekme | Route | Döküman |
|-------|-------|---------|
| Genel Bakış | `/dashboard` | [genel-bakis.md](sekmeler/genel-bakis.md) |
| Canlı Yayın Plan | `/schedules` | [canli-yayin-plan.md](sekmeler/canli-yayin-plan.md) |
| Yayın Planlama | `/yayin-planlama` | [yayin-planlama.md](sekmeler/yayin-planlama.md) |
| Stüdyo Planı | `/studio-plan` | [studyo-plani.md](sekmeler/studyo-plani.md) |
| Ingest | `/ingest` | [ingest.md](sekmeler/ingest.md) |
| Provys | `/provys-content-control` | [provys.md](sekmeler/provys.md) |
| Asrun | `/asrun` | [asrun.md](sekmeler/asrun.md) |
| Restore | `/restore` | [restore.md](sekmeler/restore.md) |

### EKİP
| Sekme | Route | Döküman |
|-------|-------|---------|
| İş Takip | `/bookings` | [is-takip.md](sekmeler/is-takip.md) |
| Haftalık Shift | `/weekly-shift` | [haftalik-shift.md](sekmeler/haftalik-shift.md) |
| Dökümanlar | `/documents` | [dokumanlar.md](sekmeler/dokumanlar.md) |

### YÖNETİM
| Sekme | Route | Döküman |
|-------|-------|---------|
| Raporlama | `/schedules/reporting` | [raporlama.md](sekmeler/raporlama.md) |
| Audit Logları | `/audit-logs` | [audit-loglari.md](sekmeler/audit-loglari.md) |
| Kanallar | `/channels` | [kanallar.md](sekmeler/kanallar.md) |
| Kullanıcılar | `/users` | [kullanicilar.md](sekmeler/kullanicilar.md) |
| Ayarlar | `/settings` | [ayarlar.md](sekmeler/ayarlar.md) |
| Bildirimler | `/notifications` | [bildirimler.md](sekmeler/bildirimler.md) |
| Live-Plan Lookup | `/admin/live-plan-lookups` | [live-plan-lookup.md](sekmeler/live-plan-lookup.md) |
| Stüdyo Planı Edit | `/admin/studio-plan-edit` | [studyo-plani-edit.md](sekmeler/studyo-plani-edit.md) |
| OPTA Lig Görünürlüğü | `/admin/opta-competitions` | [opta-lig-gorunurlugu.md](sekmeler/opta-lig-gorunurlugu.md) |
| Manuel Lig Yönetimi | `/admin/manual-leagues` | [manuel-lig-yonetimi.md](sekmeler/manuel-lig-yonetimi.md) |

> Menüde olmayan ama mevcut route: `/live-plan` (öksüz live-plan liste/detay UI) — bkz [canli-yayin-plan.md](sekmeler/canli-yayin-plan.md).

---

## Worker / Watcher (arka plan)

`worker` container'ında çalışır (`BCMS_BACKGROUND_SERVICES`). Her biri `service-heartbeat` ile izlenir.

| Servis | Tür | Döküman |
|--------|-----|---------|
| provys-watcher | dosya izleyici (BXF) | [provys-watcher.md](worker-watcher/provys-watcher.md) |
| asrun-watcher | dosya izleyici (as-run) | [asrun-watcher.md](worker-watcher/asrun-watcher.md) |
| ingest-watcher | dosya izleyici (medya) | [ingest-watcher.md](worker-watcher/ingest-watcher.md) |
| ingest-worker | RabbitMQ consumer (QC/transcode) | [ingest-worker.md](worker-watcher/ingest-worker.md) |
| ssdb-resolver | periyodik çözümleyici | [ssdb-resolver.md](worker-watcher/ssdb-resolver.md) |
| search-worker | kuyruk worker (Avid ara) | [search-worker.md](worker-watcher/search-worker.md) |
| restore-worker | kuyruk worker (Avid restore) | [restore-worker.md](worker-watcher/restore-worker.md) |
| transfer-worker | kuyruk worker (Avid transfer) | [transfer-worker.md](worker-watcher/transfer-worker.md) |
| notifications | RabbitMQ consumer (e-posta) | [notifications.md](worker-watcher/notifications.md) |
| outbox-poller | outbox → RabbitMQ yayıncı | [outbox-poller.md](worker-watcher/outbox-poller.md) |
| audit-retention | günlük temizlik job'ı | [audit-retention.md](worker-watcher/audit-retention.md) |
| audit-partition | günlük partition job'ı | [audit-partition.md](worker-watcher/audit-partition.md) |
| opta-watcher | OPTA sync (Python, ayrı container) | [opta-watcher.md](worker-watcher/opta-watcher.md) |

---

## Çapraz konular (sistem geneli)

| Konu | Döküman |
|------|---------|
| **Audit (denetim) sistemi — uçtan uca** (yakalama + saklama + görüntüleme + boşluklar) | [audit-sistemi.md](audit-sistemi.md) |
| Live-plan DB gruplama | [live-plan-db-grouping.md](live-plan-db-grouping.md) |
| Provys BXF alan notları | [provys-bxf-field-notes.md](provys-bxf-field-notes.md) |
| Keycloak tema notları | [keycloak-theme-notes.md](keycloak-theme-notes.md) |
