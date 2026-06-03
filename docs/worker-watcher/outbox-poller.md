# outbox-poller

## Özet
**Transactional outbox** desenini işleten poller: API yazma işlemleriyle aynı transaction'da `outbox_events`
tablosuna yazılan olayları okuyup **RabbitMQ**'ya güvenilir şekilde yayınlar (at-least-once, kayıp yok).

## Nerede çalışır
- **Container:** worker (`outbox-poller`)
- Başlatma: `app.ts` (background services)
- Heartbeat: `outbox-poller` (5sn / 60sn)

## Ne iş yapıyor
- `setInterval` ile `outbox_events`'ten yayınlanmamış olayları çeker — **`FOR UPDATE SKIP LOCKED`** ile çoklu
  worker güvenli, satır kilitleme.
- `outbox.routing` ile olayı doğru RabbitMQ exchange/queue'ya `publish` eder.
- Başarılı yayın → olay `published` işaretlenir.

## Neye bağlı
- **DB:** `outbox_events` (okur/günceller).
- **RabbitMQ:** olayları yayınlar (`booking.created`, `schedule.created/updated`, `live_plan.*`, `ingest.*`,
  `restore/transfer.completed` vb.).
- **Üretici:** tüm modüller (audit-cascade gibi) outbox'a yazar; bu poller dağıtır.

## Hata yönetimi
- SKIP LOCKED ile concurrency-safe; yayın hatası → olay published olmaz, sonraki tick'te tekrar denenir (at-least-once).

## İlgili kod
`apps/api/src/modules/outbox/outbox.poller.ts`, `outbox.routing.ts`, `outbox.helpers.ts`
