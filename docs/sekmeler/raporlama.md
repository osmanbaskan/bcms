# Raporlama

## Özet
Yayın (schedule) verilerinden **operasyon raporları** üretir — lig/sezon/hafta bazlı dökümler, filtreler ve export.

## Erişim
- **Nav:** YÖNETİM > Raporlama (ikon `bar_chart`)
- **Route:** `/schedules/reporting` (schedules feature içinde) → reporting component
- **Yetki:** `Admin`

## Ne yapıyor
- Schedule kayıtlarını filtreleyerek (lig, sezon, hafta, tarih aralığı) raporlar.
- Export (Excel/PDF).

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Rapor filtreleri | `GET /api/v1/schedules/reports/live-plan/filters` | `schedules` |
| Rapor / export | `/api/v1/schedules/reports/live-plan`, `.../export` | `schedules` |

**DB tabloları:** `schedules` (+ legacy `metadata/start_time/end_time` reporting B5b'ye kadar korunur).

## Bağlantılar (neye bağlı)
- **Yayın Planlama / schedules** → rapor kaynağı (`event_key IS NOT NULL` canonical filtre).
- nginx'te export endpoint'leri uzun timeout ile proxy'lenir (`reports/.../export`).

## İlgili kod
- Frontend: `apps/web/src/app/features/schedules/` (reporting)
- Backend: `apps/api/src/modules/schedules/schedule.export.ts`
