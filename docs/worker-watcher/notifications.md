# notifications

## Özet
RabbitMQ'dan gelen bildirim olaylarını tüketip **e-posta** (nodemailer/SMTP) gönderen consumer. Olay otobüsünün
"kullanıcıya ulaşan" ucu.

## Nerede çalışır
- **Container:** worker (`notifications`) — event-driven RabbitMQ consumer
- Başlatma: `app.ts` (background services)
- Heartbeat: `notifications` (event-driven; boot'ta + her mesajda, stale 10dk)

## Ne iş yapıyor
- `queue.notifications.email` (ve ilgili) kuyruğunu tüketir.
- nodemailer ile SMTP üzerinden e-posta gönderir (`sendMail`).
- (Slack kuyruğu `queue.notifications.slack` mevcut — V1'de tüketici olmayabilir.)

## Neye bağlı
- **RabbitMQ:** `queue.notifications.email` (tüketir).
- **SMTP:** `SMTP_HOST/PORT/SECURE/FROM` (dev'de mailhog `mailhog:1025`, UI `:8025`).
- **Kaynak olaylar:** outbox → outbox-poller → RabbitMQ (örn. `booking.created`, schedule olayları).

## Hata yönetimi
- Event-driven; idle'da heartbeat ticker. Gönderim hatası loglanır.

## İlgili kod
`apps/api/src/modules/notifications/notification.consumer.ts`
