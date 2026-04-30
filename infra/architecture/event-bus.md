# BCMS RabbitMQ Event Bus

> Son güncelleme: 2026-04-30
> Kuyruk tanımları: `apps/api/src/plugins/rabbitmq.ts` → `QUEUES`

BCMS asenkron iletişim için RabbitMQ kullanır. Bu doküman **aktif** ve **reserved** event'leri ayrıştırır, her event'in kontratını sabitler.

## Review Calendar

Doküman içeriğine gömülü `Stale-by` tarihlerinin **tek noktadan görünür** kaydı. Tarih geldiğinde aşağıdaki [Stale-by Review Prosedürü](#stale-by-review-prosedürü) uygulanır.

| Konu | Stale-by | Notlar |
|---|---|---|
| `queue.schedule.created` reserved review | **2026-10-31** | Consumer eklenmediyse: uzat / sil / consumer ekle kararı verilecek |
| `queue.schedule.updated` reserved review | **2026-10-31** | Aynı |
| `queue.booking.created` reserved review | **2026-10-31** | Aynı |
| `queue.ingest.completed` reserved review | **2026-10-31** | Aynı |

> **Takip mekanizması:** Şu an doküman içi review calendar yeterli. Ekip büyür veya tarih yaklaştığında consumer ihtiyacı netleşirse GitHub issue/milestone'a yükseltilebilir. Otomatik tetikleyici (cron, agent) bilinçli olarak kullanılmıyor — kalıcı state issue tracker'a aittir, agent memory'sine değil.

## Aktif Event'ler

Hem publisher hem consumer canlı; üretim akışında kritik.

### `queue.ingest.new`

| Alan | Değer |
|---|---|
| **Publisher** | `apps/api/src/modules/ingest/ingest.routes.ts:487` (POST /ingest), `ingest.watcher.ts:32` (dosya izleyici) |
| **Consumer** | `apps/api/src/modules/ingest/ingest.worker.ts:120` (worker container) |
| **Payload** | `{ jobId: number, sourcePath: string, ... }` (bkz. `ingest.routes.ts:487`) |
| **Amaç** | Yeni ingest işi → ffmpeg pipeline'ı tetikler |

### `queue.notifications.email`

| Alan | Değer |
|---|---|
| **Publisher** | `apps/api/src/modules/bookings/booking.service.ts:279`; retry `notification.consumer.ts:52` |
| **Consumer** | `apps/api/src/modules/notifications/notification.consumer.ts:35` (worker container) |
| **Payload** | E-mail bildirim payload'ı (`to`, `subject`, `body`, `_retries?: number`) |
| **Amaç** | Booking olayları sonrası SMTP üzerinden bilgilendirme; retry mantığı dahil |

---

## Reserved Event'ler

Publisher canlı, **consumer yok**. Bilinçli olarak korunuyor — gelecekteki reporting / notification / webhook / audit projection feature'ları için event-bus altyapısı hazır tutuluyor.

> **Önemli:** Bunlar "ölü kod" DEĞİLDİR. Silmeden önce stale-by review tarihine bakın. Consumer yazacak kişi bu dokümandaki payload şemasına dayanmalı, koddaki publish satırlarını okumak zorunda kalmamalı.

### `queue.schedule.created`

| Alan | Değer |
|---|---|
| **Publisher** | `apps/api/src/modules/schedules/schedule.service.ts:141` |
| **Consumer** | _(yok — reserved)_ |
| **Payload kontrat** | `{ scheduleId: number, channelId: number \| null, startTime: string \| Date, title: string }` |
| **Intended consumer** | Operasyonel bildirim (yayın listesine yeni kayıt) ve/veya audit projection |
| **Stale-by review** | **2026-10-31** |

### `queue.schedule.updated`

| Alan | Değer |
|---|---|
| **Publisher** | `apps/api/src/modules/schedules/schedule.service.ts:218` |
| **Consumer** | _(yok — reserved)_ |
| **Payload kontrat** | `{ scheduleId: number, changes: UpdateScheduleDto }` |
| **Intended consumer** | Webhook (dış sistem entegrasyonu), reporting projection, kanal/PCR alarmları |
| **Stale-by review** | **2026-10-31** |

### `queue.booking.created`

| Alan | Değer |
|---|---|
| **Publisher** | `apps/api/src/modules/bookings/booking.service.ts:217, 333` |
| **Consumer** | _(yok — reserved; e-mail bildirimi `queue.notifications.email` üzerinden ayrı yapılır)_ |
| **Payload kontrat** | `{ bookingId: number, scheduleId: number }` |
| **Intended consumer** | Slack/Teams kanal bildirimi (Slack queue kaldırıldı; ileride feature olarak yeniden tasarlanır), audit projection |
| **Stale-by review** | **2026-10-31** |

### `queue.ingest.completed`

| Alan | Değer |
|---|---|
| **Publisher** | `apps/api/src/modules/ingest/ingest.routes.ts:599` (callback), `ingest.worker.ts:182, 194` (success/fail) |
| **Consumer** | _(yok — reserved)_ |
| **Payload kontrat** | `{ jobId: number, status: 'COMPLETED' \| 'FAILED' \| string }` |
| **Intended consumer** | QC pipeline tetikleyici, reporting projection, planning ekranı için canlı durum push'u |
| **Stale-by review** | **2026-10-31** |

---

## Stale-by Review Prosedürü

`Stale-by review` tarihi **otomatik silme tetikleyicisi DEĞİLDİR.** Bir insan, o tarihte aşağıdaki üç seçenekten birini bilinçli seçmelidir:

### (a) Uzat
Niyet hâlâ canlı, sadece feature öncelik sırası kaymış.
- Yeni `Stale-by review` tarihi koy (örn. +6 ay).
- Bu dokümanda **gerekçe** yaz: hangi feature, neden bekliyor.
- Roadmap referansı varsa link et.

### (b) Sil
Niyet ölmüş; event hiç tüketilmeyecek.
- `apps/api/src/plugins/rabbitmq.ts` → `QUEUES`'tan constant'ı kaldır.
- Tüm `app.rabbitmq.publish(QUEUES.X, ...)` çağrılarını sil.
- `infra/architecture/event-bus.md` (bu dosya) → ilgili tabloyu kaldır.
- Commit + deploy yap.
- **Sonra** broker'dan queue sil:
  ```bash
  docker exec bcms_rabbitmq rabbitmqctl list_queues name messages consumers | grep <queue.name>
  # messages=0 ve consumers=0 doğrula
  docker exec bcms_rabbitmq rabbitmqctl delete_queue <queue.name>
  ```
  Sıra önemli: önce deploy (eski container'lar `assertQueue` yapmasın), sonra broker temizliği.

### (c) Consumer Ekle
Feature olgunlaştı, reserved değil aktif.
- Worker tarafında `app.rabbitmq.consume(QUEUES.X, handler)` ekle.
- Bu dokümanda event'i "Reserved" tablosundan "Aktif" tablosuna taşı.

---

## Yeni Event Eklerken

1. `apps/api/src/plugins/rabbitmq.ts` → `QUEUES`'a constant ekle.
2. Publisher kodu yaz.
3. Bu dokümana satır ekle: publisher konumu, payload kontratı, intended consumer, stale-by review (consumer hazır değilse).
4. Consumer eklenecekse worker tarafında `app.rabbitmq.consume(...)` çağrısı ekle ve dokümanda "Aktif" bölümüne yaz.

## Kaldırılan Event'ler

`Kod commit` + `Broker silme` ayrı sütunlar — git history runtime/broker state mutation'larını kapsamadığı için her iki katmanın izi burada bırakılır.

| Queue | Kod commit | Broker silme | Sebep |
|---|---|---|---|
| `queue.notifications.slack` | `2e9589c` (2026-04-30) | 2026-04-30 15:35 UTC (`rabbitmqctl delete_queue`, 0 msg / 0 consumer onaylandı) | Publisher yok, consumer yok, feature flag yok. Slack entegrasyonu yapılırsa ayrı feature olarak yeniden tasarlanır. |
