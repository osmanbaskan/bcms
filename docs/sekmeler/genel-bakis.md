# Genel Bakış (Dashboard)

## Özet
Operasyonun günlük durumunu tek ekranda toplayan **kontrol paneli**: bugünün KPI'ları, bugünün maçları/içerikleri,
yayın akışı özeti ve ingest portları durumu. Açılış sayfası.

## Erişim
- **Nav:** OPERASYON > Genel Bakış (ikon `dashboard`) — varsayılan açılış (`exactMatch`)
- **Route:** `/dashboard` → `features/dashboard/dashboard.routes` → `DashboardComponent`
- **Yetki:** `groups: []` (tüm girişli kullanıcılar)

## Ne yapıyor
- **KPI kartları** — bugünün toplam yayın/içerik sayıları (canlı, stüdyo program, eksik vb.).
- **Bugünün operasyonu** — bugünün maç/içerik kartları.
- **Canlı yayın akışı** paneli (saat bazlı liste).
- **Stüdyo programı** + **İngest portları** özet panelleri.

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Bugünün canlı verisi | `GET /api/v1/provys/live-today` | `provys` |

(Dashboard ağırlıklı olarak `provys/live-today` aggregate'ini ve diğer özet endpoint'leri tüketir.)

## Bağlantılar (neye bağlı)
- **Provys / provys_items** → bugünün canlı yayın akışı.
- **Live-plan / schedules** → bugünün planları/maçları.
- **Ingest** → port durumu özeti.
- Salt-okur özet; veri girişi diğer sekmelerde yapılır.

## İlgili kod
- Frontend: `apps/web/src/app/features/dashboard/`
