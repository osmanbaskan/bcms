# Provys

## Özet
Provys'ten gelen **BXF playout playlist** içeriğini (yayın akışı) kanal+tarih bazında gösterir. Her satır bir
playlist öğesi (program/spot); SSDB ile medya/materyal çözümleme durumu (bulundu/eksik) işlenir. Salt-okur izleme ekranı.

## Erişim
- **Nav:** OPERASYON > Provys (ikon `fact_check`)
- **Route:** `/provys-content-control` → `ProvysContentControlComponent`
- **Yetki:** neredeyse tüm gruplar (`Admin, Tekyon, Transmisyon, Booking, YayınPlanlama, SystemEng, Ingest,
  Kurgu, MCR, PCR, Ses, StudyoSefi, ProvysViewer`). `ProvysViewer` rolü **yalnız bu sekmeye** erişir (V1 izolasyon).

## Ne yapıyor
- Kanal panelleri + tarih seçimiyle playlist öğelerini listeler.
- SSDB çözümleme durumunu (medya bulundu / eksik / süre) gösterir.
- Materyal rozetleri (`provys-material-badge`), kanal panelleri (`provys-channel-panel`).

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Mevcut tarihler | `GET /api/v1/provys/dates` | `provys` |
| Playlist öğeleri | `GET /api/v1/provys/items` | `provys` |

**DB tabloları:** `provys_items` (BXF'ten ingest edilen playlist; `channel_slug + schedule_date + event_id`),
`ssdb_material_cache` (DC kod → medya çözümleme cache'i).

## Bağlantılar (neye bağlı)
- **provys-watcher** (worker) → `.bxf` dosyalarını izleyip `provys_items`'a sync eder (bu sekmenin veri kaynağı).
- **ssdb-resolver** (worker) → `provys_items`'taki materyalleri SSDB'de çözer, `ssdb_material_cache`'e yazar.
- **Restore** → SSDB'de "eksik" çıkan provys materyalleri Restore sekmesine düşer (`/provys/restore-missing`).
- **Kanallar** → `channel_slug` eşlemesi (BXF dosya adından çözülür).
- Schedule/live-plan'den **ayrı domain**, ama aynı **kanal+tarih ekseninde** kesişir.

## Çalışma mantığı / notlar
- `provys_items` doğrudan schedule/live-plan'e FK ile bağlı DEĞİL — `(channel_slug + schedule_date)` ile eşleşir.
- SSDB çözümleme `PROVYS_SSDB_RESOLVER=on` + `SSDB_*` env set iken aktif.

## İlgili kod
- Frontend: `apps/web/src/app/features/provys-content-control/`
- Backend: `apps/api/src/modules/provys/` (parser, service, channel-mapping), `apps/api/src/modules/ssdb/`
