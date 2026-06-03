# Manuel Lig Yönetimi

## Özet
Canlı Yayın Plan "Yeni Ekle / **Manuel Giriş** / Lig (opsiyonel)" dropdown'ında seçilebilecek ligleri yönetir.
OPTA görünürlüğünden **bağımsız** ayrı bir filtre (`manual_selectable`).

## Erişim
- **Nav:** YÖNETİM > Manuel Lig Yönetimi (ikon `edit_note`)
- **Route:** `/admin/manual-leagues` → `ManualLeaguesComponent`
- **Yetki:** `SystemEng`
- Ayrıca "Ayarlar > Lig / İçerik" bölümünden link kartıyla da açılır.

## Ne yapıyor
- Lig listesini `manual_selectable` toggle ile yönetir (manuel girişte seçilebilirlik).

## Veri kaynağı / API
- `/api/v1/...manual-leagues...` ilgili endpoint'ler (matches/opta modülü).
- **DB:** `leagues` (`manual_selectable` bayrağı).

## Bağlantılar (neye bağlı)
- **Canlı Yayın Plan > Yeni Ekle > Manuel Giriş** → Lig dropdown'ı bu listeden filtrelenir.
- **OPTA Lig Görünürlüğü**'nden ayrı: o OPTA seçimi içindir, bu manuel giriş içindir. Yetki ikisinde de aynı (SystemEng+Admin).

## İlgili kod
- Frontend: `apps/web/src/app/features/admin/manual-leagues/`
- Backend: `apps/api/src/modules/matches/` (veya opta), `leagues` tablosu
