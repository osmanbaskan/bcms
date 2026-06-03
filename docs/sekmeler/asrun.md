# Asrun (As-Run Kaydı)

## Özet
**Playout SONRASI** gerçekleşen yayının kaydını (as-run log) gösterir — neyin, ne zaman, hangi kanalda
gerçekten yayınlandığı. Provys "planlanan"ı, Asrun "gerçekleşen"i temsil eder.

## Erişim
- **Nav:** OPERASYON > Asrun (ikon `history`)
- **Route:** `/asrun` → `AsrunContentComponent`
- **Yetki:** `Admin, MCR, PCR, SystemEng, YayınPlanlama` (ProvysViewer **erişemez** — V1 izolasyon).

## Ne yapıyor
- As-run öğelerini kanal/tarih bazında listeler (tablo + kanal panelleri).
- Gerçekleşen yayın zamanları, DC kodları, kategoriler.

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| As-run öğeleri | `GET /api/v1/asrun/items` | `asrun` |

**DB tablosu:** `asrun_items` (as-run BXF/log dosyalarından idempotent upsert).

## Bağlantılar (neye bağlı)
- **asrun-watcher** (worker) → SMB Outbox/Ok mount'undaki `.bxf` as-run dosyalarını izleyip `asrun_items`'a yazar.
- **Kanallar** → kanal eşlemesi (dosya adından `parseAsrunFilename`).
- Provys'ten **ayrı** (ayrı klasör, ayrı parser, ayrı tablo); ikisi de SMB dosya izleyici ile beslenir.

## Çalışma mantığı / notlar
- Asrun'da **DELETE yok** — dosya silinmesi geçmiş kaydı düşürmez (audit actor `system:asrun-watcher`).
- Dosya başına idempotent upsert (composed merge yok, Provys'ten farkı bu).

## İlgili kod
- Frontend: `apps/web/src/app/features/asrun/`
- Backend: `apps/api/src/modules/asrun/` (parser, filename, service, watcher, export)
