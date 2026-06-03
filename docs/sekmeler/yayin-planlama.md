# Yayın Planlama

## Özet
"Canlı Yayın Plan"da girilen bir live-plan entry'sini **seçerek bir yayın (broadcast) kaydı oluşturur**:
gün/saat, 3 kanal slotu ve reklam/logo/format seçenekleri belirlenir. ⚠️ **İsim yanıltıcı:** ekran adı
"Yayın Planlama" ama arka planda **`schedules` tablosunu** oluşturur (Canlı Yayın Plan = `live_plan_entries`).

## Erişim
- **Nav:** OPERASYON > Yayın Planlama (ikon `event`)
- **Route:** `/yayin-planlama` → `features/yayin-planlama/yayin-planlama.routes`
  - `/yayin-planlama` → liste (`YayinPlanlamaListComponent`, mat-table)
  - `/yayin-planlama/new` → oluşturma (picker zorunlu)
  - `/yayin-planlama/:id` → düzenleme
- **Yetki:** `groups: []` (tüm girişli kullanıcılar)

## Ne yapıyor (işlevler)
- **Liste:** mevcut schedules satırlarını tarih/lig filtresiyle gösterir (mat-table: Tarih/Saat/Karşılaşma/Lig/Hafta/Kanallar).
- **Yeni:** live-plan entry **picker** (`live-plan-entry-picker.dialog`) → `eventKey + selectedLivePlanEntryId +
  scheduleDate + scheduleTime + 3 kanal + commercial/logo/format` ile `schedules` satırı yaratır.
- **PDF/yazdırma export**, satır seçimi (checkbox).

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Schedule oluştur | `POST /api/v1/schedules` (createBroadcastFlow) | `schedules` |
| Liste/güncelle | `/api/v1/schedules` (eventKey IS NOT NULL filtre) | `schedules` |
| Kanal kataloğu | `GET /api/v1/channels/catalog` | `channels` |
| Live-plan seçim (picker) | `GET /api/v1/live-plan` | `live-plan` |

**DB tabloları:** `schedules` (ana), `schedule_commercial_options`, `schedule_logo_options`, `schedule_format_options`,
`channels`, `live_plan_entries` (referans).

## Bağlantılar (neye bağlı)
- **Canlı Yayın Plan** (`live_plan_entries`) → picker buradan entry seçer; `schedules.selected_live_plan_entry_id` FK.
- **Kanallar** → 3 kanal slotu (`channel_1/2/3_id`).
- **Lookup (schedule tarafı)** → reklam/logo/format seçenekleri (ayrı tablolar; Live-Plan Lookup ekranında DEĞİL).
- **Destek katmanı** → `schedules`'a `bookings` (İş Takip), `incidents`, `timeline_events` cascade bağlanır.
- **OPTA cascade** → `eventKey='opta:<uid>'` schedule'ları saat/takım/title günceller.
- **Raporlama** (`/schedules/reporting`) → schedules'tan rapor üretir.

## Çalışma mantığı / notlar
- **`event_key` UNIQUE** (K-B3.13): aynı event ikinci schedule olamaz → `POST` ikinci kez denenirse **409**
  "Bu event Yayın Planlama'da zaten var". Bu yüzden canlı-yayın-plan'da çoğaltsan bile burada **tek** satır.
- Başlık/takım `live_plan_entry`'den kopyalanır (create anı snapshot).
- Kanal slotları create'te aynı eventKey'li **tüm** live_plan_entries'e propagate edilir.
- Optimistic locking (If-Match), hard-delete domain.
- Canonical satır işareti: `event_key IS NOT NULL` (legacy `usage_scope` kaldırıldı).

## İlgili kod
- Frontend: `apps/web/src/app/features/yayin-planlama/`
- Backend: `apps/api/src/modules/schedules/schedule.service.ts` (`createBroadcastFlow`), `schedule.routes.ts`
