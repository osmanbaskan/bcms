# Canlı Yayın Plan

## Özet
Operasyonun **veri giriş merkezi**: yayınlanacak canlı olaylar (maçlar/içerikler) buraya OPTA'dan
ya da manuel girilir, çoğaltılır, teknik detayları doldurulur. ⚠️ **İsim yanıltıcı:** ekran adı
"Canlı Yayın Plan" ve route `/schedules` olsa da, **arka planda `live_plan_entries` tablosunu** yönetir
(schedules tablosunu DEĞİL). `schedules` tablosunu "Yayın Planlama" sekmesi oluşturur.

## Erişim
- **Nav:** OPERASYON > Canlı Yayın Plan (ikon `play_circle`)
- **Route:** `/schedules` → `features/schedules/schedules.routes` → `ScheduleListComponent`
- **Yetki:** `groups: []` (tüm girişli kullanıcılar görür)

## Ne yapıyor (işlevler / butonlar)
Her satırda ikon-buton aksiyonları (`schedule-list.component`):
- **Yeni Ekle** — OPTA maç seçim dialog'u (`live-plan-entry-add-dialog`) + manuel giriş.
- **Düzenle** (`edit`) — temel bilgi/kanal düzenleme.
- **Teknik** (`settings_input_component`) — teknik detay formu (≈33 dropdown; uydu/IRD/firma/dil…).
- **Çoğalt** (`add`) — kaydı kopyalar (aynı eventKey + teknik FK'ler kopyalanır).
- **Sil** (`delete`) — hard-delete (version-aware).
- Tarih filtresi + Lig filtresi + Tam Ekran + PDF export.

## Veri kaynağı / API (bağlandığı endpoint'ler)
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| OPTA'dan ekle | `POST /api/v1/live-plan/from-opta` | `live-plan` |
| Manuel ekle | `POST /api/v1/live-plan` | `live-plan` |
| Çoğalt | `POST /api/v1/live-plan/:id/duplicate` | `live-plan` |
| Teknik detay | `GET/PUT /api/v1/live-plan/:id/technical-details` | `live-plan` |
| Sil/düzenle | `/api/v1/live-plan/:id` | `live-plan` |
| Kanal kataloğu | `GET /api/v1/channels/catalog` | `channels` |

**DB tabloları:** `live_plan_entries` (ana), `live_plan_technical_details` (1:1), `live_plan_transmission_segments` (1:N),
+ ~27 lookup tablosu (transmission_*, technical_companies, live_plan_*), `matches`, `channels`.

## Bağlantılar (neye bağlı)
- **OPTA** → `matches` tablosu (OPTA sync ile dolar). "Yeni Ekle / OPTA" buradan seçer. Görünür ligler
  "OPTA Lig Görünürlüğü" + "Manuel Lig Yönetimi" ile filtrelenir.
- **Live-Plan Lookup** (`/admin/live-plan-lookups`) → Teknik formdaki dropdown'ları besler (admin-curated).
- **Yayın Planlama** (`/yayin-planlama`) → buradaki bir entry "seçilerek" `schedules` satırı (broadcast) oluşturulur
  (`schedules.selected_live_plan_entry_id`). Çoğaltmalar aynı `event_key`'i paylaşır → `schedules.event_key` UNIQUE
  olduğu için çoğaltılsa da Yayın Planlama'da **tek** satır.
- **Ingest / Restore** → `IngestJob.target_id` ve restore akışı bu entry'leri hedefler.
- **OPTA cascade** → OPTA tekrar sync olunca `opta-cascade.service` bu entry'leri (saat/takım/title) günceller
  (teknik detaya DOKUNMAZ; `COMPLETED`/`CANCELLED` dondurulur).

## Çalışma mantığı / notlar
- `event_key`: OPTA için `opta:<uid>`, manuel için `manual:<uuid>` (backend zorlar; anti-bypass).
- `source_type`: `OPTA` | `MANUAL`.
- **Optimistic locking** zorunlu (If-Match), hard-delete domain, outbox shadow event'ler.
- Çoğaltma: başlık/takım/saat/kanal/operasyon notu + `technical_details` bağımsız child olarak kopyalanır →
  kopya aynı teknik veriyi taşır ama sonradan bağımsız düzenlenir.
- **Menüde olmayan paralel UI:** `/live-plan` route'u (`LivePlanListComponent`) aynı `live_plan_entries`'i
  yönetir ama navigasyonda yok (yalnız URL ile). Asıl kullanılan ekran budur (`/schedules`).

## İlgili kod
- Frontend: `apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts`
- Backend: `apps/api/src/modules/live-plan/` (service, routes, lookup, technical-details, segments)
- OPTA cascade: `apps/api/src/modules/opta/opta-cascade.service.ts`
