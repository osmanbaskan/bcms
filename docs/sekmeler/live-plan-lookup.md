# Live-Plan Lookup

## Özet
Canlı Yayın Plan **Teknik formundaki açılır listelerin (dropdown) seçeneklerini** yöneten master-data editörü.
Admin bir kez tanımlar, herkes ondan seçer (restoran menüsü mantığı). Entry'leri DEĞİL, dropdown kataloğunu düzenler.

## Erişim
- **Nav:** YÖNETİM > Live-Plan Lookup (ikon `tune`)
- **Route:** `/admin/live-plan-lookups` → `AdminLookupsComponent`
- **Yetki:** `Admin, SystemEng`

## Ne yapıyor (4 grup, ~27 liste)
- **Transmisyon (16):** Uydular, IRD, Fiber Hatlar, INT Kaynaklar, Tie/Demod/Sanal Kaynaklar, Feed Tipleri,
  Modülasyon, Video Kodlama, Ses Konfigürasyonu, Anahtar (Key) Tipleri, Polarizasyon, FEC, Roll-Off, ISO Feed.
- **Teknik (2, polymorphic):** Teknik Firmalar (tek tablo, type: `OB_VAN/GENERATOR/SNG/CARRIER/FIBER`),
  Ekipman Seçenekleri (tek tablo, type: `JIMMY_JIB/STEADICAM/IBM`).
- **Canlı Yayın (5):** Lokasyonlar, Kullanım Lokasyonları, Bölgeler, Diller, Off-Tube Seçenekleri.
- **Fiber Format (2):** Fiber Ses/Video Formatları.

Her liste için ekle/düzenle/sil (soft-delete).

## Veri kaynağı / API
| Aksiyon | Endpoint | Yetki |
|---------|----------|-------|
| Liste oku | `GET /api/v1/live-plan/lookups/:type` | tüm girişli (dropdown kaynağı) |
| Ekle/güncelle | `POST/PATCH /api/v1/live-plan/lookups/:type[/:id]` | SystemEng (+Admin) |
| Sil | `DELETE /api/v1/live-plan/lookups/:type/:id` | SystemEng (soft-delete) |

**DB tabloları:** `transmission_*` (16), `technical_companies`, `live_plan_equipment_options`, `live_plan_locations`,
`live_plan_usage_locations`, `live_plan_regions`, `live_plan_languages`, `live_plan_off_tube_options`, `fiber_*` (2).

## Bağlantılar (neye bağlı)
- **Canlı Yayın Plan > Teknik form** → bu listelerin değerleri ~33 dropdown'da seçilir; seçim
  `live_plan_technical_details`'e **FK** olarak yazılır. Çoğaltmada FK'ler kopyalanır.
- **Admin-curated** — OPTA/Provys beslemez, seed YOK; tamamen operatör/admin girişi. Tablolar boşsa dropdown'lar boş gelir.

## İlgili kod
- Frontend: `apps/web/src/app/features/live-plan/admin-lookups/`
- Backend: `apps/api/src/modules/live-plan/lookup.routes.ts`, `lookup.service.ts`, `lookup.registry.ts`
