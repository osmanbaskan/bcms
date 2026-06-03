# OPTA Lig Görünürlüğü

## Özet
OPTA'dan gelen **lig/turnuvalardan hangilerinin** Canlı Yayın Plan "Yeni Ekle" dropdown'ında görüneceğini yönetir.
OPTA tüm ligleri çeker; bu ekran operasyonel olarak gösterilecekleri filtreler.

## Erişim
- **Nav:** YÖNETİM > OPTA Lig Görünürlüğü (ikon `visibility`)
- **Route:** `/admin/opta-competitions` → `OptaCompetitionsComponent`
- **Yetki:** `SystemEng`
- Ayrıca "Ayarlar > Lig / İçerik" bölümünden link kartıyla da açılır.

## Ne yapıyor
- OPTA lig/turnuva listesini görünür/gizli toggle ile yönetir (tablo, slide-toggle).

## Veri kaynağı / API
- `/api/v1/opta/competitions` (görünürlük) ilgili endpoint'ler.
- **DB:** `leagues` (OPTA lig kaydı + görünürlük bayrağı).

## Bağlantılar (neye bağlı)
- **OPTA sync / opta-watcher** → `leagues` + `matches` tablolarını doldurur.
- **Canlı Yayın Plan > Yeni Ekle (OPTA)** → yalnız görünür ligler dropdown'da listelenir.
- **Manuel Lig Yönetimi** → bundan bağımsız ayrı bir filtre (manuel giriş içindir).

## İlgili kod
- Frontend: `apps/web/src/app/features/admin/opta-competitions/`
- Backend: `apps/api/src/modules/opta/`, `modules/matches/`
