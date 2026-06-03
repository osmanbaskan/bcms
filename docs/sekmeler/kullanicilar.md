# Kullanıcılar & Yetkiler

## Özet
Kullanıcıların ve **grup (yetki) atamalarının** yönetimi. Kimlik Keycloak'ta tutulur; bu ekran kullanıcı listesini
ve grup/personel tipi atamalarını gösterir/düzenler.

## Erişim
- **Nav:** YÖNETİM > Kullanıcılar (ikon `manage_accounts`)
- **Route:** `/users` → `features/users/users.routes`
- **Yetki:** `SystemEng`

## Ne yapıyor
- Kullanıcı listesi (tablo: Kullanıcı Adı / Personel Tipi / Gruplar / Durum), yeni kullanıcı, düzenleme.
- Grup atama (12 BCMS grubu), aktiflik (durum toggle).

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Kullanıcılar | `GET/POST/PUT /api/v1/users` | `users` |

**Kaynak:** Keycloak realm `bcms` (kullanıcılar + `groups` claim). Backend Keycloak admin API ile konuşur.

## Bağlantılar (neye bağlı)
- **Keycloak** → kimlik + gruplar (RS256 JWT `groups` claim). Yetki tüm uygulamada bu gruplara dayanır.
- **Tüm sekmeler** → erişim, kullanıcının gruplarına göre belirlenir (`data.groups` + `requireGroup`).
- 12 grup: `Admin, Tekyon, Transmisyon, Booking, YayınPlanlama, SystemEng, Ingest, Kurgu, MCR, PCR, Ses, StudyoSefi`
  (+ `ProvysViewer` yalnız Provys izolasyonu). `Admin` her şeyi bypass eder.

## İlgili kod
- Frontend: `apps/web/src/app/features/users/`
- Backend: `apps/api/src/modules/users/`, `apps/api/src/plugins/auth.ts`
- Gruplar/yetki: `packages/shared/src/types/rbac.ts`
