# Restore

## Özet
**Avid Interplay 3 kademeli iş akışı** ile bugün ve gelecekteki **eksik materyalleri** arşivden geri getirir:
**Kademe 1 = Ara (search)**, **Kademe 2 = Restore (offline→online)**, **Kademe 3 = Transfer (Cloud UX/playout)**.
SSDB'de "eksik" çıkan provys materyalleri burada operatör tarafından işlenir.

## Erişim
- **Nav:** OPERASYON > Restore (ikon `restore_page`)
- **Route:** `/restore` → `RestoreComponent`
- **Yetki:** `Admin, MCR, PCR, SystemEng, YayınPlanlama, Ingest, Tekyon, Transmisyon, Booking, Kurgu, Ses,
  StudyoSefi` (ProvysViewer hariç — Provys.read kapsamı).

## Ne yapıyor
- **Eksik Materyaller** listesi (bugün+gelecek, SSDB `missing_material`).
- **Arama İşleri (Kademe 1)** / **Restore İşleri (Kademe 2)** / **Transfer İşleri (Kademe 3)** — restore_jobs aşamaları.
- "SSDB Toplu Yenile" (resolver tetikleme), tarih-kapsamlı (today-future).

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Eksik materyaller | `GET /api/v1/provys/restore-missing` | `provys` |
| Restore işleri (liste) | `GET /api/v1/restore/jobs?date=` | `restore` |
| İş kuyruğa al | `POST /api/v1/restore/jobs` (enqueueRestoreJob) | `restore` |

**DB tabloları:** `restore_jobs`, `search_jobs`, `transfer_jobs`, `ssdb_material_cache`.

## Bağlantılar (neye bağlı)
- **SSDB** → eksik materyal tespiti (`ssdb_material_cache.lookup_status = missing_material`).
- **Avid Interplay/MediaCentral** → 3 kademe gerçek işlemler:
  - search-worker (Kademe 1) → Avid IPWS arama
  - restore-worker (Kademe 2) → Avid SubmitJobUsingProfile (offline→online)
  - transfer-worker (Kademe 3) → Cloud UX/CTMS submitSTPJob (playout'a transfer)
- **Provys** → eksik materyallerin kaynağı (`provys_items` + SSDB).
- **Ayarlar > Avid Bağlantı Ayarları** → bu worker'ların IPWS/Cloud UX bağlantı bilgisi.

## Çalışma mantığı / notlar
- Liste **today-future** kapsamlı (`scheduleDate >= bugün`, İstanbul). Geçmiş tarihli işler pencereden çıkar.
- restore_jobs **kullanıcı-tetikli** (otomatik oluşmaz); SSDB resolver eksikleri *tespit eder* ama restore işini açmaz.
- Avid mock mode default ON (`RESTORE_AVID_MOCK=true`) — gerçek Avid bağlantısı env/Ayarlar ile açılır.

## İlgili kod
- Frontend: `apps/web/src/app/features/restore/`
- Backend: `apps/api/src/modules/restore/`, `search/`, `transfer/`, `avid/`
