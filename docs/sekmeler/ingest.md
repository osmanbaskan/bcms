# Ingest

## Özet
Canlı yayın planı ve stüdyo planı ingest (medya alımı) departmanını **tek akışta** gösterir: hangi içerik
hangi porttan kaydedilecek/alınacak, ingest planı, kayıt portları ve QC durumu. Medya dosyaları izlenen
klasöre düşünce QC/transcode işlenir.

## Erişim
- **Nav:** OPERASYON > Ingest (ikon `cloud_upload`)
- **Route:** `/ingest` → `features/ingest/ingest.routes` → `IngestListComponent`
- **Yetki:** `Admin, Ingest`

## Ne yapıyor (sekmeler/işlevler)
- **Ingest Planlama** — canlı yayın + stüdyo planı kayıtları, kaynak filtreleri (Tümü/Canlı Yayın/Stüdyo Planı), tarih.
- **Port Görünümü** — kayıt portlarına atanmış işler.
- **Ingest** — ingest job'ları (QC sonuçları, durum).
- Filtreler: Tüm Plan / Bugünün İşleri / Aktif İşler / Port Atanmamış / Sorunlular.

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Ingest plan/listesi | `GET /api/v1/ingest`, `/ingest/plan` | `ingest` |
| Live-plan adayları | `GET /api/v1/ingest/live-plan-candidates` | `ingest` |
| Schedule adayları | `GET /api/v1/schedules/ingest-candidates` | `schedules` |
| Kayıt portları | `GET/PUT /api/v1/ingest/recording-ports` | `ingest` |
| Kanal kataloğu | `GET /api/v1/channels/catalog` | `channels` |

**DB tabloları:** `ingest_jobs`, `ingest_plan_items`, `ingest_plan_item_ports`, `recording_ports`, `qc_reports`,
`live_plan_entries`, `schedules`, `incidents`.

## Bağlantılar (neye bağlı)
- **Canlı Yayın Plan / live_plan_entries** → ingest adayları (`IngestJob.target_id` → live_plan_entry).
- **Yayın Planlama / schedules** → schedule kaynaklı ingest adayları.
- **ingest-watcher** (worker) → `WATCH_FOLDER`'a düşen medya dosyalarını yakalar.
- **ingest-worker** (worker) → RabbitMQ ile QC (ffprobe loudness/codec/süre) + transcode, `qc_reports` yazar.
- **Kayıt Portları** → "Ayarlar" ekranından da yönetilir (`recording_ports`).
- **incidents** → ingest sorunları olay olarak kaydedilebilir.

## Çalışma mantığı / notlar
- QC eşikleri (ingest-worker): loudness max -16 LUFS, min süre 60sn, codec allow-list (h264/h265/prores/dnxhd).
- Kayıt portları "Ayarlar" sekmesinde de düzenlenir (ortak `recording_ports` tablosu).

## İlgili kod
- Frontend: `apps/web/src/app/features/ingest/`
- Backend: `apps/api/src/modules/ingest/` (service, routes, worker, watcher)
