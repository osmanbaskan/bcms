# Outbox PR-D (Replay + Retention + Dedup + Cleanup) — V1 Tasarım Gereksinimleri

> **Status**: ✅ Requirements locked (2026-05-06 §8 kararları kapatıldı). Implementation pending — PR-C2 production cut-over yeşil olduktan sonra PR-D1 başlar.
> **Tarih**: 2026-05-06
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 2 + 7.
> **Pre-req**:
>   - `ops/REQUIREMENTS-OUTBOX-DLQ-V1.md` (üst tasarım — §7 admin/metric/alert + §8 Phase 4 + §9 PR-E opsiyon)
>   - `ops/REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md` (Phase 3 cut-over)
>   - `ops/RUNBOOK-OUTBOX-POLLER-CUTOVER.md` (cut-over runbook)
> **Pre-req production**: PR-C2 cut-over deployed + ≥24 saat soak + failed/dead alarm 0 + duplicate email rapor yok.

## 0. Özet

Phase 3 cut-over sonrası (poller authoritative + direct publish disabled), aşağıdaki eksikler tamamlanır:

1. **Replay endpoint** — `dead`/`failed` outbox event'lerini manuel `pending`'e taşıma (SystemEng/Admin auth).
2. **Failed/dead visibility** — Admin endpoint + opsiyonel UI listesi.
3. **Retention** — `published` event'ler 30 gün sonra purge (PR-A locked); `dead` event'ler manuel replay'e kadar tutulur.
4. **Persistent notification dedup** — Cut-over penceresi/restart'a karşı consumer-side persistent deduplication (PR-D core scope DEĞİL — opsiyonel sub-PR; ihtiyaç teyidi sonrası).
5. **Metrics/alerts tuning** — PR-A locked metric'ler aktive + alert eşik kalibrasyonu.
6. **Final cleanup** — Direct publish env-gated branch'leri kod tabanından **sil** (Phase 4); feature flag env kaldır.

**Bu doc'ta kapsam dışı:**
- Per-aggregate ordering guarantee (V2).
- Multi-instance worker + jitter (V2).
- LISTEN/NOTIFY swap (poller polling → push) (V2).
- Event sourcing / CQRS (out of program).

---

## 1. PR-D Alt-PR Sıralaması

PR-D tek değil, **5-6 alt PR**'a bölünür:

```
PR-D1 — Admin replay endpoint + failed/dead listing
PR-D2 — Outbox retention job (published + dead retention)
PR-D3 — Metrics + alert tuning (Prometheus + alerts.yml)
PR-D4 — Persistent notification dedup (opsiyonel, ihtiyaç teyidi)
PR-D5 — Phase 4 cleanup (direct publish kod silme + feature flag kaldır)
PR-D6 — UI replay panel (opsiyonel, frontend) — REQUIREMENTS-OUTBOX-DLQ-V1.md §9 PR-E ile birleşik
```

Her alt-PR ayrı production deploy + ayrı smoke; toplu cut-over değil.

---

## 2. PR-D1 — Admin Replay + Listing Endpoint

### 2.1 API yüzeyi

```
GET  /api/v1/admin/outbox?status=failed|dead|pending|published&aggregateType=&eventType=&page=&pageSize=
GET  /api/v1/admin/outbox/:id          # detay (payload, last_error, attempts, idempotency_key)
POST /api/v1/admin/outbox/:id/replay   # body: { reason: string }
POST /api/v1/admin/outbox/replay-bulk  # body: { ids: number[]; reason: string }
```

**Auth (§8 karar 3)**: Hardcode group adı yerine `@bcms/shared` `PERMISSIONS` map'ine yeni satır:

```ts
// packages/shared/src/types/rbac.ts
admin: {
  // ...
  outbox: ['Admin', 'SystemEng'] as BcmsGroup[],
}
```

Route handler standart `requireGroup(...PERMISSIONS.admin.outbox)` pattern'ini kullanır (Admin auto-bypass `isAdminPrincipal()` mevcut davranışı).

**Replay reason (§8 karar 4 — zorunlu)**: Body schema:

```ts
const replaySchema = z.object({
  reason: z.string().trim().min(10).max(500),
});
const replayBulkSchema = z.object({
  ids:    z.array(z.number().int().positive()).min(1).max(50), // §8 karar 5
  reason: z.string().trim().min(10).max(500),
});
```

Reason eksik / kısa / uzun → 400 (Zod). Audit log'a tam reason yazılır.

**Audit log**: Replay action her zaman `audit_logs`'a yazılır:
- request user (preferred_username + groups)
- target eventId(s)
- before status (failed | dead)
- after status (pending)
- replay reason (zorunlu — operator izi)

### 2.2 Response shape

```ts
interface OutboxAdminListResponse {
  items: Array<{
    id: number;
    eventId: string;
    eventType: string;
    aggregateType: string;
    aggregateId: string;
    status: 'pending'|'published'|'failed'|'dead';
    attempts: number;
    lastError: string | null;
    idempotencyKey: string | null;
    occurredAt: string;
    nextAttemptAt: string;
    publishedAt: string | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
}
```

Detay endpoint payload'ı da içerir (truncate UI tarafında; backend full döner).

### 2.3 Replay davranışı

**Kritik invariant (ek guard 2026-05-06)**: Replay **yeni outbox row yaratmaz**; mevcut `failed`/`dead` event'in **state'ini reset eder**:

```sql
UPDATE outbox_events
SET status = 'pending',
    attempts = 0,
    next_attempt_at = NOW(),
    last_error = NULL
WHERE id = ?;
-- event_id, idempotency_key, payload, occurred_at DEĞİŞMEZ.
```

Sebep: `event_id` (UUID v4 idempotency anchor) ve `idempotency_key` (cross-producer dedup, partial unique) **korunur** — yeni row yaratmak bu yüzeyi kirletir + downstream consumer dedup mantığını bozar.

**Status guard'ları:**
- `failed` / `dead` → `pending` (replay valid).
- `pending` → 409 (zaten kuyrukta; replay anlamsız).
- `published` → 409 (event zaten yayınlandı; replay yeni publish üretir → duplicate). PR-D4 persistent dedup yok ise consumer-side koruma yok; bu yüzden API-level reddedilir.

### 2.4 Bulk replay structured response (§8 karar 5)

`POST /api/v1/admin/outbox/replay-bulk` **best-effort** çalışır (atomic değil — `replay-bulk` semantik olarak "her item için sonuç döner"):

```ts
interface ReplayBulkResponse {
  results: Array<{
    id: number;
    outcome: 'replayed' | 'not_found' | 'invalid_status' | 'error';
    fromStatus?: 'failed' | 'dead' | 'pending' | 'published';
    error?: string; // outcome='error' için
  }>;
  summary: {
    requested: number;
    replayed:  number;
    skipped:   number; // not_found + invalid_status + error
  };
}
```

Her ID kendi tx'inde güncellenir (kısmi başarı kabul). UI/CLI hangi item başarısız anlar; failed item'lar tekrar denenebilir.

**Atomic toplu mode** opsiyonel (`?atomic=true` query param) — ihtiyaç doğarsa V2; V1 default best-effort.

**Bulk limit (§8 karar 5)**: 50 item/request. Üzerinde 400 (Zod). Daha büyük replay ihtiyacı için CLI script + paginated calls (PR-D5 sonrası operasyonel doc).

### 2.5 Test kapsamı

- **Auth**: non-admin/non-SystemEng user → 403; Admin auto-bypass çalışıyor mu.
- **List**: filter combinations (status, aggregateType, eventType, pagination); total/page/pageSize correctness.
- **Detail**: not found → 404; full payload + last_error + idempotency_key dönüyor mu.
- **Replay happy**: `dead` → `pending` (attempts=0, next_attempt_at≈NOW, last_error=NULL); `event_id` + `idempotency_key` + `payload` **DEĞİŞMEDİ** assertion (ek guard).
- **Replay status guard'ları**: `pending` → 409; `published` → 409.
- **Replay reason**: eksik/<10/>500 char → 400 (Zod issues).
- **Audit log**: replay sonrası `audit_logs`'ta entry var; reason field dolu.
- **Bulk replay structured**: 5 ID karması (2 dead + 1 not_found + 1 published + 1 pending) →
  - response.summary: `{ requested:5, replayed:2, skipped:3 }`
  - results array'de her item'ın outcome'u doğru.
- **Bulk replay limit**: 51 ID → 400.

---

## 3. PR-D2 — Retention Job

### 3.1 Locked decisions (PR-A REQUIREMENTS-OUTBOX-DLQ-V1.md)

- **Published**: 30 gün sonra purge.
- **Dead**: manuel replay'e kadar tutulur (otomatik silinmez).
- **Failed**: poller backoff schedule'da; otomatik silinmez (sonunda dead'e geçer).

### 3.2 Job tasarımı

`apps/api/src/modules/outbox/outbox-retention.job.ts` (audit-retention pattern):

```ts
const RETENTION_DAYS = 30;
const TR_TIMEZONE = 'Europe/Istanbul';

async function runOnce() {
  const cutoff = istanbulNow() - RETENTION_DAYS;
  const result = await prisma.outboxEvent.deleteMany({
    where: {
      status: 'published',
      publishedAt: { lt: cutoff },
    },
  });
  app.log.info({ deleted: result.count, cutoff, retentionDays: RETENTION_DAYS },
    'Outbox retention complete');
}
```

- Daily run (24h interval); midnight Istanbul (audit-retention pattern).
- Background service `outbox-retention` (BCMS_BACKGROUND_SERVICES'a eklenir).
- Dry-run env: `OUTBOX_RETENTION_DRY_RUN=true`.

### 3.3 Index review

PR-A'da `(status, next_attempt_at)` index var. Retention query `WHERE status='published' AND published_at < cutoff` kullanır → mevcut index yetersiz (next_attempt_at değil published_at). Yeni index gerekebilir:

```sql
CREATE INDEX outbox_events_published_at_idx
  ON outbox_events(published_at)
  WHERE status = 'published';
```

Partial index — sadece published satırları (retention scope). Migration: `20260506000002_outbox_retention_index`.

Test setup helper'a reapply (Madde 4 / PR-A pattern).

### 3.4 Test kapsamı

- 30 günden eski published satır → silinir.
- 30 günden yeni published → korunur.
- `failed`/`dead`/`pending` → silinmez (status guard).
- Dry-run: count log; satır silinmez.
- Index varlığı sanity.

---

## 4. PR-D3 — Metrics + Alert Tuning

### 4.1 Prometheus metrics (PR-A §7.2 locked — şimdi aktive)

Metric implementasyonu (`apps/api/src/plugins/metrics.ts`):

```ts
const outboxPending = new client.Gauge({ name: 'bcms_outbox_pending_count', help: '...' });
const outboxFailed  = new client.Gauge({ name: 'bcms_outbox_failed_count',  help: '...' });
const outboxDead    = new client.Gauge({ name: 'bcms_outbox_dead_count',    help: '...' });
const outboxOldestPendingAge = new client.Gauge({
  name: 'bcms_outbox_oldest_pending_age_seconds',
  help: '...',
});

// async-collector pattern — Madde 1 PR-1D ile aynı
async function refreshOutboxGauges() {
  const counts = await prisma.outboxEvent.groupBy({
    by: ['status'], _count: true,
  });
  // ...gauge'ları güncelle
  const oldest = await prisma.$queryRaw<{min: Date|null}[]>`
    SELECT MIN(next_attempt_at) AS min
    FROM outbox_events WHERE status='pending'
  `;
  outboxOldestPendingAge.set(oldest[0]?.min ? (Date.now() - new Date(oldest[0].min).getTime()) / 1000 : 0);
}
```

### 4.2 Alert rules (PR-A §7.3 locked)

`alerts.yml`'e ekle:

```yaml
- alert: BCMSOutboxFailedNonZero
  expr: bcms_outbox_failed_count > 0
  for: 10m
  labels: { severity: warning, area: outbox }

- alert: BCMSOutboxDead
  expr: bcms_outbox_dead_count > 0
  for: 0m
  labels: { severity: critical, area: outbox }

- alert: BCMSOutboxPendingLag
  expr: bcms_outbox_oldest_pending_age_seconds > 1800
  for: 5m
  labels: { severity: warning, area: outbox }
```

### 4.3 Alert eşik kalibrasyonu

Cut-over sonrası ≥1 hafta soak boyunca:
- `failed` baseline ölçülür (RMQ stabil iken 0 beklenir; geçici network hipi olabilir).
- `pending_lag` 99-percentile baseline (poller sağlıklı çalışırken).
- Eşikler bu baseline'a göre ayarlanır (gerekirse alert.yml güncellemesi).

### 4.4 Test kapsamı

- Metric endpoint scrape: 4 gauge mevcut.
- Async collector: status breakdown query çalışıyor.
- Alert rule sentaks: `promtool check rules`.

---

## 5. PR-D4 — Persistent Notification Dedup (opsiyonel)

### 5.1 İhtiyaç teyidi (§8 karar 1)

PR-C2 cut-over runbook §3 uyarı: in-memory consumer dedup restart-safe değil. Cut-over penceresi sonrası **gerçek duplicate email rapor olmuşsa** bu PR uygulanır; rapor yoksa V2 scope'a alınır.

**Kritik clarification**: PR-D1 replay endpoint'i **duplicate email üretmez**:
- Replay sadece state reset (status reset, yeni row yok).
- Aynı `event_id` korunduğu için poller publish ederken yine aynı eventId yayar.
- Consumer-side dedup yokken, replay edilen event consumer tarafında duplicate olarak gözükür **YALNIZCA** önceki publish başarılı consume edilmişse (`published` status'ta zaten reddedilir).
- `failed`/`dead` event'lerin tanımı: önceki publish **başarılı değil** → consumer mesajı işlememiş → replay duplicate üretmez.
- Sonuç: PR-D4 persistent dedup, replay endpoint güvenliği için **gerekli değil**; cut-over deploy penceresi (Phase 2 → Phase 3 geçişi) için ayrı bir koruma.

PR-D4 conditional kararı bu yüzden duplicate-email-rapor'a bağlı, replay endpoint'in güvenliğine bağlı değil.

### 5.2 Tasarım opsiyonları

| Opsiyon | Yöntem | Pros | Cons |
|---|---|---|---|
| **A — DB tabanlı** | `notification_dedup` tablosu: `eventId UNIQUE PK`, `processedAt`. Consumer önce INSERT (ON CONFLICT DO NOTHING); 0 row → skip. | Persistent; restart-safe; replay-safe. | Yeni tablo + retention; her email per round-trip iki query. |
| **B — Redis** | Redis `SET`/`SADD` eventId, TTL 7 gün. | Hızlı; mevcut Redis varsa minimum sürtünme. | Yeni dependency (mevcut stack'te yok); single point of failure. |
| **C — Outbox status check** | Consumer outbox tablosundan `published_at IS NOT NULL` doğrulamasıyla skip. | Mevcut tabloyu kullanır. | Coupling artar (consumer outbox'a bağlanır); ölçek sorunu (table grow). |

### 5.3 Önerilen: Opsiyon A (DB)

Yeni tablo `notification_dedup`:

```sql
CREATE TABLE notification_dedup (
  event_id VARCHAR(36) PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX notification_dedup_processed_at_idx ON notification_dedup(processed_at);
```

Consumer akışı:
```ts
const result = await prisma.notificationDedup.create({
  data: { eventId },
}).catch((e) => {
  if (e.code === 'P2002') return null; // unique conflict → already processed
  throw e;
});
if (!result) {
  app.log.info({ eventId }, 'Duplicate notification skip (persistent dedup)');
  return;
}
// ... mail gönder
```

Outbox payload'a eventId taşımak gerekir (poller → consumer). Şu an direct publish payload object only (`{ to, subject, body }`); poller publish'i de aynı payload'ı gönderiyor (PR-C1 routing). PR-D4'te poller envelope kısmı (eventId) consumer'a iletilebilir → RMQ message properties (`messageId`).

### 5.4 Retention

`notification_dedup` 7 gün retention (eventId UUID v4 unique olduğu için 7 gün sonra collision riski sıfır).

### 5.5 Test

- Aynı eventId iki defa consume → ikinci skip + log.
- Distinct eventId: ikisi de işlenir.
- Dedup tablosu retention.

---

## 6. PR-D5 — Phase 4 Final Cleanup

### 6.1 Kapsam

PR-C2'de env-gated bırakılmış 8 publish site (`OUTBOX_POLLER_AUTHORITATIVE` koşulu) **tamamen silinir**:

```diff
- if (!process.env.OUTBOX_POLLER_AUTHORITATIVE) {
-   await app.rabbitmq.publish(QUEUES.X, payload);
- } else {
-   app.log.debug({ ... }, 'direct publish skipped — outbox poller authoritative');
- }
```

Sadece outbox shadow yazımı kalır; tek code path.

### 6.2 Env temizliği

- `OUTBOX_POLLER_AUTHORITATIVE` env kaldırılır (.env.example, docker-compose, runbook).
- `OUTBOX_POLLER_ENABLED` env korunur (poller hâlâ koşar; sadece authoritative cut-over flag silinir; default true production).

### 6.3 Test kapsamı

- Service spec'leri tek mod ile koş (env toggle artık yok).
- writeShadowEvent default `'pending'` (shadow→pending PR-C2 davranışı kalıcı).
- Direct publish hiç olmamalı (test'te `harness.publishedEvents` poller process'inde dolar; service-level direct yok).

### 6.4 Doc cleanup

- `RUNBOOK-OUTBOX-POLLER-CUTOVER.md` — historical; status "completed".
- `REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md` — status "completed; V2 scope listesi".
- Audit doc Madde 2 + 7 closure (program tamamlandı).

---

## 7. PR-D6 — UI Replay Panel (opsiyonel)

REQUIREMENTS-OUTBOX-DLQ-V1.md §9 PR-E referansı. Frontend sayfası:

- `/admin/outbox` route (Angular standalone component).
- Status filter chip'leri (pending/failed/dead/published).
- Detail modal: payload formatted JSON, last_error, attempts, idempotency_key.
- Replay button (single + bulk select).
- Real-time refresh (poller interval 10sn — UI opsiyonel WebSocket V2).

**PR-D5 önce tamamlandığı için backend stable; UI sade replay/listing tüketimi.**

Auth: `Admin` group navigasyonu görür; backend de aynı kontrol.

---

## 8. Kararlar — kapatıldı (2026-05-06)

| # | Karar | V1 |
|---|---|---|
| 1 | **PR-D4 (persistent notification dedup) conditional** | Cut-over penceresi sonrası duplicate email rapor varsa scheduled; yoksa V2 scope. PR-D1 replay endpoint güvenliği persistent dedup'a bağlı **değil** (§5.1 clarification). |
| 2 | **PR-D6 (UI panel) ayrı** | Backend (PR-D1..D5) stable olmadan frontend boşa zaman. PR-D6 PR-D5 sonrası. |
| 3 | **RBAC permission `PERMISSIONS.admin.outbox`** | Yeni satır `@bcms/shared/rbac.ts`'e: `outbox: ['Admin','SystemEng']`. Hardcode group adı yok; route handler `requireGroup(...PERMISSIONS.admin.outbox)`. |
| 4 | **Replay reason zorunlu** | Zod `z.string().trim().min(10).max(500)`. Audit log'a yazılır (operatör izi). Eksik/kısa/uzun → 400. |
| 5 | **Bulk replay limit 50, structured response** | `replay-bulk` best-effort (atomic değil). Per-item outcome: `replayed | not_found | invalid_status | error`. Summary count. Atomic mode (`?atomic=true`) opsiyonel V2. |

### 8.1 Ek invariant guard (2026-05-06)

**Replay yeni outbox row yaratmaz** (§2.3 detayı). Mevcut event'in state'i reset edilir; `event_id`, `idempotency_key`, `payload`, `occurred_at` korunur. Bu invariant idempotency yüzeyini ve cross-producer dedup'ı bozmaz.

---

## 9. PR-D Genel PR Sıralaması

```
PR-D1 — Admin replay + listing endpoint (~3 gün)
  ├─ Backend route + RBAC + audit log integration
  ├─ Test
  └─ Production deploy

PR-D2 — Retention job + index migration (~2 gün)
  ├─ outbox-retention.job.ts
  ├─ migration: published_at partial index
  ├─ Test
  └─ Production deploy

PR-D3 — Metrics + alerts (~1 gün)
  ├─ Prometheus gauge + async collector
  ├─ alerts.yml ekle
  ├─ Soak ≥1 hafta + eşik kalibrasyon
  └─ Production deploy

PR-D4 — Persistent notification dedup (CONDITIONAL — duplicate rapor varsa)
  ├─ notification_dedup tablosu + migration
  ├─ Consumer akış güncelleme
  ├─ Test
  └─ Production deploy

PR-D5 — Phase 4 cleanup (~1 gün)
  ├─ 8 site direct publish kod silme
  ├─ Env temizlik
  ├─ Doc cleanup + audit closure
  └─ Production deploy

PR-D6 — UI replay panel (opsiyonel, ~3-5 gün)
  ├─ Angular component
  ├─ Detail modal + replay action
  └─ Production deploy
```

PR-D toplam tahmini: ~10 gün backend (PR-D4 hariç) + opsiyonel ~5 gün frontend.

---

## 10. Pre-req Doğrulamaları (PR-D1 başlamadan önce)

- [ ] PR-C2 production deploy ≥24 saat soak.
- [ ] failed/dead alarm 0; duplicate email rapor yok (PR-D4 conditional kararı buna bağlı).
- [ ] poller throughput baseline ölçüldü (saniyede event count + p99 publish latency).
- [ ] outbox_events row count + büyüme rate ölçüldü (retention design'a girdi).
- [ ] Admin/SystemEng kullanıcılarla replay UX ihtiyacı doğrulandı (CLI yeterli mi UI gerekli mi).

---

**Maintainer**: kullanıcı (osmanbaskan)
**Implementer**: Claude (PR-D1 talep edildiğinde — PR-C2 production soak yeşil olduktan sonra)
