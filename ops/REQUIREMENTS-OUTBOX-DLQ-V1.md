# Outbox + DLQ V1 — Tasarım Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Audit doc skip listesi **Madde 2** (DLQ topology) + **Madde 7** (Outbox pattern) — birlikte tasarlanır (kullanıcı kararı 2026-05-05): tek DB-merkezli failure model = tek surface, iki ayrı topology yerine.
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 2 + 7.
> **Pattern**: `ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md` ile aynı design-first yapı.

## Amaç

İki problemi tek mimari ile çözmek:

1. **Madde 7 (Outbox)**: `prisma.commit() → rabbitmq.publish()` arasında inconsistency penceresi — RMQ outage'da event eksik kalır, notification email/downstream sistemler bilmez.
2. **Madde 2 (DLQ)**: Mevcut interim retry (`redelivered=false→requeue, true→drop`, commit `0238771`) failed message için tarih/sebep yok, manual replay yok, görünürlük sıfır.

İkisi birlikte çözülürse → tek `outbox_events` tablosu hem **transactional event publish** garanti eder (commit ile aynı tx) hem **failed state visibility + replay** sunar.

> **Out of scope (bu doc):**
> - Audit log için outbox (audit plugin `$extends` + `onSend` flush zaten transactional pattern; ayrı concern).
> - BPM / event sourcing / CQRS (sadece transactional outbox; minimal).
> - Per-aggregate ordering guarantee (§5 ordering note).

---

## 1. Mevcut Durum (read-only verify)

### 1.1 Service-side publish sites

| Yer | Pattern | Risk |
|---|---|---|
| `schedule.service.ts:210-215` (create) | `tx.commit() → rabbitmq.publish(SCHEDULE_CREATED)` | Outbox olmaması: RMQ down → event kayıp |
| `schedule.service.ts:268-271` (update) | aynı | aynı |
| `booking.service.ts:240` (create) | aynı (`BOOKING_CREATED`) | aynı |
| `booking.service.ts:302` (update status APPROVED/REJECTED) | aynı (`NOTIFICATIONS_EMAIL`) | **Müşteri kritik**: email kayıp riski |
| `ingest.routes.ts` callback | `INGEST_NEW`, `INGEST_COMPLETED` | aynı |

### 1.2 Mevcut consumer-side retry

`apps/api/src/plugins/rabbitmq.ts` (commit `0238771`):
- Parse fail → drop (1MB cap).
- Handler error: `redelivered=false → requeue` (1 retry); `redelivered=true → drop + log`.
- `notification.consumer` 3 attempt + `_meta.retries` → drop log.
- DLQ topology yok.

### 1.3 Boş alanlar

- Failed message tarihi yok (drop log'larda kalır).
- Manual replay yok.
- Operasyonel görünürlük yok (admin endpoint yok, metric yok).

---

## 2. Stack Seçimi — DB-Merkezli Outbox

### 2.1 Karşılaştırma

| Seçenek | Pro | Con |
|---|---|---|
| **A. DB-merkezli `outbox_events`** | Tek surface (failure + replay); transactional guarantee; SQL filter; admin endpoint kolay | Polling (latency 1-2 sn); DB write yükü |
| B. RabbitMQ DLX per-queue | RMQ idiomatic; broker-managed | Failure visibility zayıf; replay endpoint + UI gerek; per-queue × 2 sayı patlaması |
| C. PG LISTEN/NOTIFY | Düşük latency | Payload 8KB sınırı; PG-specific; failure state ayrı yer |

**Karar**: A. BCMS ölçeğinde (~20K msg/gün) DB write yükü ihmal edilebilir; operasyonel görünürlük çok daha iyi. Audit log infrastructure'ı zaten benzer pattern (`$extends` + `onSend`).

### 2.2 At-least-once ve Idempotency (acceptance, not risk)

> **Önemli**: Outbox pattern **at-least-once** delivery garanti eder. Duplicate publish her zaman mümkün — örneğin poller event'i publish edip ack'ten önce crash ederse, sonraki tick aynı event'i tekrar publish eder.
>
> Bu **risk değil, mimari sözleşme**. Consumer tarafında **idempotency zorunluluk** (acceptance criteria):
> - Her event'in `eventId` (UUID v4) field'ı vardır.
> - Consumer ya `eventId`'i kaydeder (`processed_event_ids` tablo veya in-memory set + TTL) ya da business action idempotent'tir (örneğin `INSERT ... ON CONFLICT DO NOTHING`, `UPDATE WHERE status != 'X'`).
> - Mevcut consumer'lar değerlendirilmeli:
>   - `notification.consumer`: email gönderimi inherently idempotent değil → `eventId` dedup gerek.
>   - `ingest.worker`: zaten dedup var (`existing.status !== 'PENDING' return` — commit `0c7a8af`).

Idempotency PR-2A öncesi audit edilir; eksiklik tespit edilirse her consumer'a dedup eklenir (PR-2A sub-task veya ayrı PR).

### 2.3 Ordering Guarantee — YOK

Outbox V1 **per-aggregate ordering garanti etmez**. Aynı `aggregate_id` için iki event paralel publish edilebilir; consumer sırayı önemsemiyor olmalı.

Eğer ordering kritik bir use-case çıkarsa (örn. "Schedule CREATE'den önce UPDATE consume edilemez"):
- Per-aggregate sequencing (tek-thread poller per aggregate) ayrı karar.
- Ya da event payload'da version field + consumer "ben gördüğüm en yüksek version'dan eskiyi atlarım" pattern'i.

V1 sadece "events delivered eventually" sözü verir.

---

## 3. Event Envelope Standardı

Her outbox event'i aşağıdaki shape ile yazılır (payload alanı domain-specific):

```ts
interface OutboxEnvelope {
  eventId:       string;   // UUID v4 — unique, idempotency anchor
  eventType:     string;   // 'schedule.created', 'booking.status_changed', vb.
  aggregateType: string;   // 'Schedule', 'Booking', 'IngestJob'
  aggregateId:   string;   // numeric or string identifier
  occurredAt:    string;   // ISO 8601 UTC; commit timestamp
  schemaVersion: number;   // 1 (v1); evrim için
  payload:       unknown;  // domain-specific JSON
}
```

**Notlar:**
- `eventId` UUID v4: client-side generate (`crypto.randomUUID()`).
- `eventType` snake/dot — RMQ routing key olarak da kullanılabilir.
- `schemaVersion`: payload field eklenirse +1; consumer eski version'ları graceful handle.
- Mevcut RMQ consumer'ları envelope-aware update edilmeli (PR-2A sub-task veya PR-2B kapsamı).

---

## 4. `outbox_events` Tablo Taslağı

```prisma
model OutboxEvent {
  id              Int      @id @default(autoincrement())
  /// UUID v4; idempotency anchor; consumer dedup key.
  eventId         String   @unique @map("event_id") @db.VarChar(36)
  eventType       String   @map("event_type") @db.VarChar(100)
  aggregateType   String   @map("aggregate_type") @db.VarChar(50)
  aggregateId     String   @map("aggregate_id") @db.VarChar(50)
  schemaVersion   Int      @default(1) @map("schema_version")
  payload         Json
  /// pending | published | failed | dead
  status          String   @default("pending") @db.VarChar(20)
  attempts        Int      @default(0)
  lastError       String?  @map("last_error") @db.Text
  occurredAt      DateTime @map("occurred_at") @db.Timestamptz(6)
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  publishedAt     DateTime? @map("published_at") @db.Timestamptz(6)
  /// Poller buradan sonra dener; backoff schedule.
  nextAttemptAt   DateTime @default(now()) @map("next_attempt_at") @db.Timestamptz(6)

  @@index([status, nextAttemptAt])  // Poller hot-path
  @@index([aggregateType, aggregateId])  // Lookup/replay
  @@index([eventType])
  @@map("outbox_events")
}
```

**State machine**: `pending → published` (happy path); `pending → failed → pending` (backoff retry); `failed → dead` (max attempts aşıldı; manual replay only).

**DB CHECK constraint** (migration ile, schema.prisma'da yorum):
```sql
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_status_check
  CHECK (status IN ('pending','published','failed','dead'));
```

(Madde 4 `usageScope` ile aynı pattern.)

---

## 5. Service Refactor

Mevcut:
```ts
const schedule = await prisma.$transaction(...);
await app.rabbitmq.publish(QUEUES.SCHEDULE_CREATED, payload);  // 🔴 transaction dışı
```

Yeni:
```ts
const result = await prisma.$transaction(async (tx) => {
  const schedule = await tx.schedule.create(...);
  await tx.outboxEvent.create({
    data: {
      eventId: crypto.randomUUID(),
      eventType: 'schedule.created',
      aggregateType: 'Schedule',
      aggregateId: String(schedule.id),
      schemaVersion: 1,
      payload: { scheduleId: schedule.id, channelId, ... },
      occurredAt: new Date(),
    },
  });
  return schedule;
});
// RMQ publish poller'ın işi
```

**Etki:**
- Service kodu basitleşir (RMQ knowledge service'ten dışarı).
- Transaction rollback → hem entity hem event rollback (atomic).
- Latency artar 1-2 sn (poller interval) — UI gerçek-zamanlı değil zaten.

---

## 6. Worker Poller Tasarımı

`apps/api/src/modules/outbox/outbox.poller.ts` (yeni background service):

```ts
const POLL_INTERVAL_MS = 2_000;       // 2 sn (configurable)
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;        // 5sn × 2^attempts; cap 30 dk

async function pollOnce() {
  const events = await prisma.$transaction(async (tx) => {
    return tx.$queryRaw`
      SELECT * FROM outbox_events
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY next_attempt_at
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
  });

  for (const event of events) {
    try {
      await rabbitmq.publish(routingKey(event), envelope(event));
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'published', publishedAt: new Date() },
      });
    } catch (err) {
      const nextAttempts = event.attempts + 1;
      const isDead = nextAttempts >= MAX_ATTEMPTS;
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** event.attempts, 30 * 60_000);
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: isDead ? 'dead' : 'failed',
          attempts: nextAttempts,
          lastError: String((err as Error).message ?? err),
          nextAttemptAt: new Date(Date.now() + backoff),
        },
      });
    }
  }
}
```

**Özellikler:**
- `FOR UPDATE SKIP LOCKED` — multi-instance worker safe (concurrent poller'lar aynı event'i pick etmez).
- Exponential backoff: 5s, 10s, 20s, 40s, 80s; cap 30 dk.
- `failed → pending` (next_attempt_at geçince poller tekrar pick); `failed → dead` (max attempts).
- Dry-run env: `OUTBOX_POLLER_DRY_RUN=true` → publish skip, status değişmez (sadece log).

**Lifecycle:**
- Background service `audit-partition`/`audit-retention` pattern'i (boot + interval + onClose cleanup).
- `BCMS_BACKGROUND_SERVICES` listesine `outbox-poller`.

---

## 7. Failure State + Admin Visibility

### 7.1 Admin endpoint

```
GET  /api/v1/admin/outbox?status=failed|dead|pending&aggregateType=&page=&pageSize=
POST /api/v1/admin/outbox/:id/replay   # status reset → pending, attempts=0, next_attempt_at=NOW()
```

Auth: `requireGroup(GROUP.SystemEng)` (Admin auto-bypass mevcut pattern).

### 7.2 Prometheus metric

3 yeni gauge (`metrics.ts`'e eklenir, async-collector pattern Madde 1 PR-1D ile aynı):
- `bcms_outbox_pending_count` — `WHERE status='pending'`
- `bcms_outbox_failed_count` — `WHERE status='failed'`
- `bcms_outbox_dead_count` — `WHERE status='dead'`
- `bcms_outbox_oldest_pending_age_seconds` — en eski `pending` event'in `next_attempt_at`'tan beri bekleme süresi

### 7.3 Alert rules (`alerts.yml`)

```yaml
- alert: BCMSOutboxFailedNonZero
  expr: bcms_outbox_failed_count > 0
  for: 10m
  labels: { severity: warning, area: outbox }

- alert: BCMSOutboxDead
  expr: bcms_outbox_dead_count > 0
  for: 0m
  labels: { severity: critical, area: outbox }
  annotations:
    summary: "Outbox event(s) dead state — manual replay/inspection gerekli"

- alert: BCMSOutboxPendingLag
  expr: bcms_outbox_oldest_pending_age_seconds > 1800
  for: 5m
  labels: { severity: warning, area: outbox }
  annotations:
    summary: "Outbox poller pending event'leri 30 dakikadan uzun süredir publish edemiyor"
```

---

## 8. 4-Phase Rollout Plan (Dual-publish riski açık)

> **Kritik**: Feature flag ile hem direct publish hem outbox poller aynı event'i publish ederse **duplicate event** çıkar. Phase'ler sırayla, her geçiş ayrı PR + production deploy.

### Phase 1 — Tablo + Poller disabled
- PR-A: `outbox_events` tablo + Prisma model + migration.
- Service kodu **dokunulmaz**; direct publish aynen çalışıyor.
- Poller container/service **enable edilmemiş** (feature flag `OUTBOX_ENABLED=false`).
- Risk: sıfır. Tablo boş kalır.

### Phase 2 — Service outbox write enabled, direct publish ALSO enabled (shadow mode)
- PR-B: `schedule.service.create()` ve `booking.service.create()` outbox write **eklenir**, direct publish **aynen kalır**.
- **Poller hâlâ disabled** (`OUTBOX_ENABLED=false`).
- Mantık: outbox doluyor (verify edilebilir); ama publish'i hâlâ direct yapan kod sağlıyor.
- Bu **shadow mode**: outbox row count metric'i izlenir (gauge'lar Phase 1'de var); duplicate publish **YOK** çünkü poller kapalı.
- Risk: outbox tablosu büyür ama hiçbir consumer outbox'tan okumadığı için dış davranış aynı.

### Phase 3 — Poller enabled + direct publish disabled
- PR-C: Service'ten direct `rabbitmq.publish()` **kaldırılır**; sadece `tx.outboxEvent.create()`. Poller `OUTBOX_ENABLED=true`.
- **Tek source publish var**: poller. Duplicate yok.
- Geçiş anı kritik: Phase 2 sonunda outbox tablosunda eski (Phase 2 yazılmış) event'ler var, hepsi `pending`. Poller başlatınca **Phase 2 birikimini hemen drain etmeye çalışır** → consumer'lar bu event'leri Phase 2 sırasında zaten direct publish'ten almış olabilir (duplicate). Bu yüzden:
  - Phase 2 → Phase 3 geçiş öncesi: Phase 2'de yazılan event'leri **manuel `status='published'` mark et** (idempotent, consumer zaten almış varsayım); ya da phase 2 outbox writes initial `status='published'` ile yazılsın (skip poll).
  - **Default önerim**: Phase 2'de service `tx.outboxEvent.create({ status: 'published', publishedAt: NOW() })` yazılsın (shadow mark). Phase 3'te status default'u `pending`'e çevrilir.
- Risk: yine de race penceresi var; consumer idempotency (eventId dedup) zorunlu (§2.2).

### Phase 4 — Direct publish code removed
- PR-D: Direct publish call'ları kod tabanından **silinir** (Phase 3'te disable edildi, şimdi tamamen temizlenir).
- Feature flag `OUTBOX_ENABLED` env'inden de kaldırılır.
- Final state: tek code path = outbox.

**Geri dönüş**: Phase 3'te bir hata bulunursa → feature flag false (poller stop); Phase 2 davranışına döner. Phase 4 sonrası rollback için kod revert + service restart.

---

## 9. Migration / Rollout Sıralaması

```
PR-A (Phase 1 hazırlık):
  ├─ migration: outbox_events tablo + index + CHECK constraint
  ├─ Prisma model OutboxEvent
  ├─ feature flag env (OUTBOX_ENABLED, OUTBOX_POLLER_DRY_RUN)
  ├─ poller iskeleti (BCMS_BACKGROUND_SERVICES'a 'outbox-poller'); enable koşullu
  ├─ test: model insert/update + state machine
  └─ Production deploy → Phase 1

PR-B (Phase 2 shadow):
  ├─ schedule.service.create/update: tx.outboxEvent.create({ status: 'published' }) shadow mode
  ├─ booking.service: aynı (status değişiklikleri için NOTIFICATIONS_EMAIL event'i de outbox'a)
  ├─ test: shadow mode write doğrulama; poller disabled invariant
  ├─ Direct publish AYNEN; davranış değişmez
  └─ Production deploy → Phase 2

PR-C (Phase 3 cut-over):
  ├─ Service: direct publish kaldır
  ├─ Phase 2 birikimi mark published manual ops step (runbook)
  ├─ Feature flag default true (OUTBOX_ENABLED=true)
  ├─ Phase 2 outbox writes: status default 'pending' (shadow değil)
  ├─ Poller enable
  ├─ Admin endpoint + metric + alert
  ├─ Idempotency audit notification consumer (eventId dedup)
  └─ Production deploy + maintenance window → Phase 3

PR-D (Phase 4 cleanup):
  ├─ Direct publish call'ları kod tabanından sil
  ├─ Feature flag env'inden kaldır
  ├─ Doc cleanup
  └─ Production deploy → Phase 4

PR-E (opsiyonel, ileride):
  ├─ Failed/replay UI (admin frontend panel)
  └─ Bu doc kapsamı dışı; istenirse ayrı PR
```

---

## 10. Açık Karar Noktaları (PR öncesi netleş)

| # | Karar | Seçenekler | Default önerim |
|---|---|---|---|
| 1 | Polling vs LISTEN/NOTIFY | (a) polling 2sn (b) NOTIFY trigger + listener | (a) — basit, predictable; NOTIFY 8KB sınır + connection-bound |
| 2 | Poll interval default | 2sn / 5sn / 10sn | 2sn — UI gerçek-zamanlı değil ama notification email için kabul |
| 3 | MAX_ATTEMPTS | 3 / 5 / 10 | 5 — exponential backoff 5 deneme = ~80 dk total window |
| 4 | Backoff cap | 10 dk / 30 dk / 1 saat | 30 dk |
| 5 | Phase 2 shadow mode write status | (a) 'published' (b) 'pending' but poller disabled | (a) — simpler; Phase 3 cut-over net |
| 6 | Idempotency yer | (a) consumer'da eventId dedup (b) handler-level idempotent business logic (c) ikisi | (c) — mevcut ingest dedup zaten var, notification için dedup eklenir |
| 7 | Replay UI gerekiyor mu | (a) admin endpoint yeter (b) frontend panel ekle | (a) — V1 yeter; UI ileride |
| 8 | Per-aggregate ordering | (a) yok (V1) (b) sequence per aggregate | (a) — V1 |
| 9 | Outbox retention | (a) `published` event'leri 30 gün sonra purge (b) saklama yok | (a) — `audit-retention` benzeri pattern; ayrı job |

---

## 11. Risk + Bağımlılık

| Risk | Değerlendirme | Mitigation |
|---|---|---|
| Phase 3 cut-over duplicate publish | Phase 2 birikimi + poller başlatınca | Phase 2 shadow status='published'; consumer idempotency |
| Poller tek-instance bottleneck | BCMS tek worker container | `FOR UPDATE SKIP LOCKED` zaten multi-safe; ileride scale-out |
| DB write yükü | Her event +1 INSERT | Şu an ~20K msg/gün → ~20K INSERT/gün; ihmal edilebilir |
| Outbox tablosu büyür | `published` event'ler birikiyor | Karar #9: 30-gün retention purge |
| RMQ down → poller failed status birikir | Backoff ile yavaşlar; alert tetiklenir | Manuel replay; failed retention monitoring |
| Consumer idempotency eksikliği | Duplicate side-effect (örn. iki email) | §2.2 acceptance + audit |

**Bağımlılık zinciri:**
- PR-A → PR-B → PR-C → PR-D sıralı; aralarında production gözlem süresi (önerilen 1-2 hafta).
- Madde 8 (test foundation) zaten var; outbox spec'leri PR-A ile birlikte gelir.

---

## 12. Acceptance Criteria

PR-A merge için:
- [ ] `outbox_events` migration + Prisma model.
- [ ] CHECK constraint status enum.
- [ ] BackgroundService poller iskeleti (disabled by default).
- [ ] `OUTBOX_ENABLED`, `OUTBOX_POLLER_DRY_RUN` env'ler dokümante.
- [ ] Integration test: state machine (pending→published, pending→failed→pending, failed→dead).
- [ ] `apps/api lint` + `apps/web build` yeşil.

PR-B merge için (PR-A merge'den sonra prod gözlem 1-2 hafta):
- [ ] Schedule + booking service outbox shadow write.
- [ ] Test: shadow row count = direct publish count (parite).
- [ ] Production: outbox tablosu doluyor, consumer hâlâ direct'ten alıyor (davranış aynı).

PR-C merge için (PR-B prod gözlem sonrası):
- [ ] Direct publish kaldır.
- [ ] Phase 2 birikimi manual mark published runbook.
- [ ] Idempotency audit consumer'larda tamamlandı.
- [ ] Admin endpoint + Prometheus metric + alert.
- [ ] **Acceptance**: Consumer idempotency (eventId dedup veya idempotent business logic) — her consumer için doğrulandı.

PR-D merge için:
- [ ] Direct publish kod kaldırıldı.
- [ ] Feature flag temizlendi.

---

## 13. Onay Akışı

1. Açık karar noktaları (§10): kullanıcı seçimi (özellikle MAX_ATTEMPTS, poll interval, retention).
2. PR sıralaması (§9): kullanıcı onayı.
3. Phase 2/3 prod gözlem süresi: 1-2 hafta önerilir; kısaltma kararı kullanıcıya.
4. Idempotency audit (§2.2): PR-A öncesi her consumer için durum tespit + plan.
5. PR-A açılır → review → merge.
