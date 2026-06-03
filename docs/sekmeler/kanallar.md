# Kanallar

## Özet
Yayın **kanallarının** (beINSports1, beINSportsDigital1, beINSportsHaber…) yönetimi: ad, tip (HD/SD/OTT/RADIO),
frekans, mux bilgisi, aktiflik. Sistemin her yerindeki kanal slotlarının kaynak kataloğu.

## Erişim
- **Nav:** YÖNETİM > Kanallar (ikon `tune`)
- **Route:** `/channels` → `features/channels/channels.routes`
- **Yetki:** `Admin`

## Ne yapıyor
- Kanal listesi (tablo: Kanal Adı / Tip / Frekans), ekleme/düzenleme/pasifleştirme.

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Kanallar | `GET/POST/PUT /api/v1/channels` | `channels` |
| Katalog (dropdown kaynağı) | `GET /api/v1/channels/catalog` | `channels` |

**DB tablosu:** `channels` (id, name UNIQUE, type, frequency, mux_info, active, soft-delete).

## Bağlantılar (neye bağlı)
- **Canlı Yayın Plan / Yayın Planlama** → 3 kanal slotu (`channel_1/2/3_id`) bu katalogdan seçilir.
- **Provys / Asrun** → `channel_slug` eşlemesi (BXF dosya adından çözülen kanal kodu).
- **Ingest** → kanal kataloğu kayıt portu atamasında kullanılır.
- Hemen her tablodaki "kanal" alanının kaynağı.

## İlgili kod
- Frontend: `apps/web/src/app/features/channels/`
- Backend: `apps/api/src/modules/channels/`
