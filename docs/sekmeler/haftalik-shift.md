# Haftalık Shift

## Özet
Ekip için **haftalık vardiya (shift) planlaması** — kim hangi gün/vardiyada çalışacak. Haftalık görünüm,
düzenleme ve dışa aktarma (export).

## Erişim
- **Nav:** EKİP > Haftalık Shift (ikon `calendar_today`)
- **Route:** `/weekly-shift` → `WeeklyShiftComponent`
- **Yetki:** `Admin, SystemEng`

## Ne yapıyor
- Haftalık vardiya ızgarası (kişi × gün/vardiya), düzenleme.
- Export (Excel/yazdırma).

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Vardiyalar | `GET/PUT /api/v1/weekly-shifts` | `weekly-shifts` |
| Export | `GET /api/v1/weekly-shifts/export` | `weekly-shifts` |

**DB tabloları:** `weekly-shifts` ilgili tablolar (shift_assignments vb.).

## Bağlantılar (neye bağlı)
- **Keycloak/kullanıcılar** → vardiyaya atanan kişiler.
- Bağımsız bir EKİP yönetim modülü; operasyon planlamasından (schedule/live-plan) ayrı.

## İlgili kod
- Frontend: `apps/web/src/app/features/weekly-shift/`
- Backend: `apps/api/src/modules/weekly-shifts/`
