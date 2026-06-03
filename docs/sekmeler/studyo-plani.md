# Stüdyo Planı

## Özet
Stüdyo programlarının **haftalık plan/ızgara** görünümü — hangi program, hangi gün/saat, hangi stüdyoda/renkte.
Stüdyo şefi katalog yönetimini "Stüdyo Planı Edit" (admin) ekranından yapar; bu sekme planı gösterir/düzenler.

## Erişim
- **Nav:** OPERASYON > Stüdyo Planı (ikon `view_module`)
- **Route:** `/studio-plan` → `StudioPlanComponent`
- **Yetki:** `groups: []` (tüm girişli kullanıcılar)

## Ne yapıyor
- Haftalık slot ızgarası (program × gün/saat), renk kodlu.
- Hafta bazlı zaman aralığı ayarı (varsayılan 07:00–02:00).

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Stüdyo planı | `/api/v1/studio-plans` | `studio-plans` |
| Kullanım raporu | `GET /api/v1/studio-plans/reports/usage` | `studio-plans` |

**DB tabloları:** `studio_plans` (hafta bazlı, version), `studio_plan_slots`, `studio_plan_colors`, `studio_plan_programs`.

## Bağlantılar (neye bağlı)
- **Stüdyo Planı Edit** (`/admin/studio-plan-edit`) → program+renk kataloğunu yönetir (StudyoSefi/Admin).
- **Ingest** → stüdyo planı kayıtları ingest adayı olabilir (`ingest/plan/report`).
- Optimistic locking (version), soft-delete.

## İlgili kod
- Frontend: `apps/web/src/app/features/studio-plan/`
- Backend: `apps/api/src/modules/studio-plans/`
