# İş Takip

## Özet
Jira-benzeri **iş/görev takip** sistemi: ekip içi görevler oluşturulur, kişiye atanır, durum (PENDING/APPROVED/…)
ve çoklu yorum ile takip edilir. Bir görev opsiyonel olarak bir yayın (schedule) ile ilişkilendirilebilir.

## Erişim
- **Nav:** EKİP > İş Takip (ikon `people_outline`)
- **Route:** `/bookings` → `features/bookings/bookings.routes`
- **Yetki:** `Admin, SystemEng`

## Ne yapıyor
- Görev oluşturma/düzenleme (başlık, detay, atanan, başlangıç/bitiş tarihi, grup).
- Durum yönetimi (`PENDING/APPROVED/REJECTED/CANCELLED`) + durum geçmişi.
- Çoklu **yorum** (plain text), atanabilir kişi listesi.

## Veri kaynağı / API
| Aksiyon | Endpoint | Backend modül |
|---------|----------|---------------|
| Görevler | `GET/POST/PATCH /api/v1/bookings` | `bookings` |
| Atanabilir kişiler | `GET /api/v1/bookings/assignees` | `bookings` |

**DB tabloları:** `bookings`, `booking_comments`, `booking_status_history`, `schedules` (opsiyonel FK), `matches`, `teams`.

## Bağlantılar (neye bağlı)
- **schedules** (Yayın Planlama) → görev bir schedule'a bağlanabilir (`booking.schedule_id`, ON DELETE CASCADE).
- **matches / teams** → opsiyonel maç/takım ilişkisi.
- **Keycloak** → atanan kişi (`assignee_id` = preferred_username) + grup.
- **outbox** → `booking.created` olayı yayınlanır → notifications (e-posta).
- **Optimistic locking** (version), soft-delete (`deleted_at`).

## İlgili kod
- Frontend: `apps/web/src/app/features/bookings/`
- Backend: `apps/api/src/modules/bookings/`
