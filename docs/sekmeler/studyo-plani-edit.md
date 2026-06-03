# Stüdyo Planı Edit

## Özet
Stüdyo planı **katalog yönetimi**: programlar ve renkleri (Stüdyo Planı sekmesinin slot'larında kullanılan
master-data). Stüdyo şefinin program/renk tanımladığı admin ekranı.

## Erişim
- **Nav:** YÖNETİM > Stüdyo Planı Edit (ikon `edit`)
- **Route:** `/admin/studio-plan-edit` → `StudioPlanEditComponent`
- **Yetki:** `Admin, StudyoSefi` (SystemEng burada YOK — kullanıcı kararı)

## Ne yapıyor
- Program kataloğu (ekle/düzenle/sil) + renk ataması.

## Veri kaynağı / API
- `/api/v1/studio-plans` ilgili program/renk endpoint'leri.
- **DB:** `studio_plan_programs`, `studio_plan_colors`.

## Bağlantılar (neye bağlı)
- **Stüdyo Planı** (`/studio-plan`) → buradaki program+renk kataloğu, haftalık plan slot'larında seçilir.

## İlgili kod
- Frontend: `apps/web/src/app/features/admin/studio-plan-edit/`
- Backend: `apps/api/src/modules/studio-plans/`
