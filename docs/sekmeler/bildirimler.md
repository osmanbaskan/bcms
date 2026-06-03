# Bildirimler

## Özet
Uygulama-içi (in-app) **bildirim sistemi** — bir olay olunca (örn. ingest tamamlandı) ilgili
kullanıcılara **gerçek zamanlı** tarayıcı bildirimi + **uyarı sesi** + uygulama-içi toast düşer.
Model **kullanıcı-bazlı**: admin sekme bazlı bildirim **tiplerini tanımlar**; her kullanıcı
**gördüğü sekmelere ait** bildirimleri tek tek **açar/kapatır** ve **sesini** (Sessiz/Normal/Acil)
seçer. Seçim **kalıcıdır** (DB) — yeniden girişte hatırlanır.

> Kapsam: **BCMS sekmesi açıkken** (SSE). Tarayıcı/sekme kapalıyken bildirim (Web Push) V1'de yok.

## Erişim
- **Nav:** YÖNETİM > Bildirimler (ikon `notifications`)
- **Route:** `/notifications` → `NotificationsComponent`
- **Yetki:** Tüm giriş yapmış kullanıcılar (`PERMISSIONS.notifications.read = []` = all authenticated).
  **Tip katalogu yönetimi** (admin bölümü) yalnız `Admin` / `SystemEng`
  (`PERMISSIONS.notifications.config`).

## Ne yapıyor
- **Her kullanıcı (Bildirim Aboneliklerim):** erişebildiği aktif tipler **sekme bazlı** gruplanır;
  her tip için **Açık/Kapalı** toggle + **ses seçimi** (🔇 Sessiz / 🔔 Normal / ⛑️ Acil).
  Açık = bildirim gelir (+ seçilen ses); Kapalı = hiç gelmez.
- **Tarayıcı bildirimleri:** izin durumu + "İzin ver" butonu. Ses, sayfayla **ilk etkileşimde**
  otomatik açılır (Chrome autoplay politikası).
- **Admin (Tip Katalogu):** bildirim tiplerini tanımlar/düzenler/siler — `key`, `label`,
  `section` (sekme), `requiredGroups` (erişebilen gruplar), `severity`, `sound`, `defaultOn`,
  `active`. "Test bildirimi" butonu (admin).

## Çalışma mantığı
```
Olay → createNotification(type,…) → Notification kaydı + pg_notify('bcms_notify', payload)
     → SSE /notifications/stream (her bağlı kullanıcı kendi süzgeci ile)
     → Frontend: toast + tarayıcı Notification + SES (kullanıcının tip-bazlı tercihi)
```
**Teslim süzgeci (kullanıcı başına):** bildirim kullanıcıya gider eğer
**(a)** tipe erişimi var (`requiredGroups ∩ JWT.groups`, ya da `Admin`) **VE**
**(b)** efektif-abone (abonelik satırı varsa `enabled`, yoksa tipin `defaultOn`'u).
**Ses:** kullanıcının o tip için seçtiği ses (`subscription.sound`), yoksa tipin varsayılan sesi;
`off` ise sessiz (bildirim yine görünür).

## Veri kaynağı / API
| Aksiyon | Endpoint | Not |
|---------|----------|-----|
| Gerçek-zamanlı akış | `GET /api/v1/notifications/stream` | SSE (fetch-streaming, Bearer JWT) |
| Liste | `GET /api/v1/notifications` | `page,pageSize,onlyUnread` |
| Okunmadı sayısı | `GET /api/v1/notifications/unread-count` | zil rozeti |
| Oku / hepsini oku | `POST /…/:id/read` · `POST /…/read-all` | |
| Aboneliklerim | `GET /…/subscriptions` | erişilebilir tipler + efektif aç/kapa + ses |
| Abonelik aç/kapa + ses | `PUT /…/subscriptions` | `{ typeKey, enabled, sound? }` |
| Tip katalogu (admin) | `GET/PUT /…/types` · `DELETE /…/types/:key` | `config` yetkisi |
| Manuel oluştur (admin) | `POST /api/v1/notifications` | test/duyuru |

**DB tabloları:** `notifications`, `notification_reads`, `notification_types` (admin katalog),
`notification_subscriptions` (kullanıcı aç/kapa + ses). Migration: `20260604100000_add_notifications`.

## Sesler
İki dosya: `assets/sounds/notify-normal.mp3` (yumuşak çift-ton), `notify-critical.mp3` (üçlü acil
bip). Kullanıcı tip bazında `off/normal/critical` seçer. Autoplay için ilk tıkla "unlock".

## Bağlantılar (neye bağlı)
- **SSE + pg_notify** (`bcms_notify`) — provys SSE deseninin paraleli; nginx'te dedicated location
  (`/api/v1/notifications/stream`, buffering off).
- **Keycloak grupları** — yalnız **sekme erişimini** (hangi tipleri açabileceğini) belirler; asıl
  tercih kullanıcıda (kullanıcı-bazlı model).
- **Global `NotificationService`** — app.component `ngOnInit`'te `start()`; SSE'ye bağlanır, ses
  çalar, tarayıcı bildirimi + toast + okunmadı sayacı.
- **Audit ext** — tüm Notification/abonelik/katalog yazımları audit'lenir; `pg_notify` raw değil
  (provys deseni, `$executeRaw SELECT pg_notify`).

## Durum (faz)
- **Faz 1 (backend) + Faz 2 (frontend):** ✅ tamam — abonelik, ses, tarayıcı bildirimi, admin katalog.
- **Faz 3 (gerçek olaylara otomatik bağlama):** ⏳ bekliyor. Şu an bildirimler **manuel/test** ile
  üretiliyor. Bağlanacak olaylar (kullanıcı listesi netleşince): ingest tamamlandı/hata, restore
  bitti/hata, booking oluştu/değişti, schedule oluştu/değişti, servis/watcher düştü.

## İlgili kod
- Backend: `apps/api/src/modules/notifications/` (`notification.pg-listener.ts`,
  `notification.service.ts`, `notification.routes.ts`), `app.ts` (kayıt + seed),
  `packages/shared/src/types/rbac.ts` (`PERMISSIONS.notifications`)
- Frontend: `apps/web/src/app/features/notifications/` (`notifications.component.ts`,
  `notification.service.ts`, `notification-sse.client.ts`, `notification.types.ts`),
  `app.component.ts` (nav + wiring), `app.routes.ts`
- Altyapı: `infra/docker/nginx.conf` (SSE location), `apps/web/src/assets/sounds/`
