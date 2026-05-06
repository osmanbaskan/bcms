# Outbox Poller Cut-over (Phase 3) — V1 Tasarım Gereksinimleri

> **Status**: ✅ Requirements doc — 4 açık karar kapatıldı (2026-05-06); implementation pending. PR-C kapsamı.
> **Tarih**: 2026-05-06
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 2 + 7.
> **Pre-req**: `ops/REQUIREMENTS-OUTBOX-DLQ-V1.md` § 6/8/9 — bu doc o tasarımın **dar uygulama planı**.
> **Decision pre-req**: `ops/DECISION-INGEST_COMPLETED-AUTHORITATIVE-PRODUCER.md` (sub-option B2 — idempotency key foundation).

## 0. Özet

Phase 2 shadow tüm domain'lerde aktif (Schedule + Booking + Notification + Ingest INGEST_NEW + INGEST_COMPLETED). Bu PR-C cut-over'da:

1. **Outbox poller** authoritative publisher olur (`pending → published`).
2. **Direct publish** çağrıları service'lerden kaldırılır.
3. **Cut-over guard'ları** smoke test + rollback path ile sağlanır.

**Bu PR'da YOKTUR** (sonraki):
- Replay UI / admin endpoint (PR-D)
- Direct publish KOD silinmesi — bu PR'da `if (OUTBOX_ENABLED) skip` (Phase 4 PR-D temizler)
- Outbox retention/cleanup (PR-D)

---

## 1. Mevcut Durum (read-only verify)

### 1.1 Phase 2 shadow durumu (tüm domain'ler)

| Domain | Service | Direct publish queue | Shadow event type | Idempotency key? |
|---|---|---|---|---|
| Schedule create | `schedule.service.ts:create()` | `queue.schedule.created` | `schedule.created` | – |
| Schedule update | `schedule.service.ts:update()` | `queue.schedule.updated` | `schedule.updated` | – |
| Booking create | `booking.service.ts:create()` | `queue.booking.created` | `booking.created` | – |
| Booking notif | `booking.service.ts:update()` (status APPROVED/REJECTED) | `queue.notifications.email` | `notification.email_requested` | – |
| Ingest watcher | `ingest.watcher.ts` | `queue.ingest.new` | `ingest.job_started` | – |
| Ingest manual | `ingest.service.ts:triggerManualIngest()` | `queue.ingest.new` | `ingest.job_started` | – |
| Ingest completed worker | `ingest.service.ts:finalizeIngestJob()` | `queue.ingest.completed` | `ingest.job_completed` | **`ingest.job_completed:IngestJob:{id}:{status}`** |
| Ingest completed callback | `ingest.service.ts:processIngestCallback()` (terminal only) | `queue.ingest.completed` | `ingest.job_completed` | **aynı key** |

**Phase 2 invariant**: `tx.outboxEvent.create({ status: 'published' })` — poller pick etmez (poller `WHERE status='pending'`).

### 1.2 Mevcut consumer-side dedup

`apps/api/src/modules/notifications/notification.consumer.ts` (sole active consumer): in-memory `Set<eventId>` cache (PR-A öncesi `0238771`). Shadow event'lerin eventId'si UUID v4; consumer cache zaten dedup ediyor → cut-over sırasında race penceresi minimize edilir.

---

## 2. Poller State Machine

### 2.1 Status transitions (DB-level)

```
                (insert)
                   │
                   ▼
              [ pending ]
               │      │
   poller pick │      │ MAX_ATTEMPTS reached
               ▼      ▼
         [ published ]   [ dead ]
                              ▲
                              │ (manual replay PR-D)
                              │
        [ failed ] (transient retry; next_attempt_at scheduled)
              ▲
              │ publish error
              │
         (poller pick again after backoff)
```

### 2.2 Status semantics

| Status | Anlam | Poller davranışı |
|---|---|---|
| `pending` | Henüz publish edilmedi; `next_attempt_at <= NOW()` ise pick eligible | Pick + publish dener |
| `published` | Başarılı publish; `published_at` set | Skip (no further work) |
| `failed` | Transient hata (retry); `next_attempt_at` backoff schedule'a göre ileri | Wait until `next_attempt_at <= NOW()`, sonra retry |
| `dead` | MAX_ATTEMPTS aşıldı; manuel müdahale | Skip (admin replay PR-D) |

**Phase 2 → Phase 3 geçişi**: Mevcut shadow row'ları `status='published'` (Phase 2 invariant). Poller bu satırlara dokunmaz; cut-over anında **eski outbox content drain etme problemi yok** (Phase 2 invariant'ın amacı buydu).

### 2.3 Cut-over anı: shadow default değişimi

**Bu PR'ın kritik tek satırı:**

```diff
- status: 'published',
- publishedAt: new Date(),
+ status: 'pending',
+ publishedAt: null,  // veya bu kolonu hiç set etme
```

`outbox.helpers.ts:writeShadowEvent()` (raw + Prisma path ikisi de) cut-over'da `pending` yazmalı; aksi halde poller hiçbir event pick etmez.

**Senkronizasyon problemi:**
- Phase 2 son commit'i: shadow mode `'published'`.
- PR-C deploy anı: kod `'pending'` yazmaya başlar; aynı anda direct publish kaldırılır.
- Kod deploy + DB davranışı atomik DEĞİL → kısa pencere'de `pending` yazılır AMA poller henüz devreye girmemiştir → event publish edilmez.

**Çözüm sıralaması (deploy steps):**
1. Önce **poller deploy** ile (`OUTBOX_POLLER_ENABLED=true`); shadow yazımı `'published'` kalmaya devam → poller hiçbir şey pick etmez (zaten published).
2. Smoke test: poller başladı, lag metrikleri normal, hiç pick yok.
3. **Sonra cut-over commit**: shadow yazımı `'pending'` + direct publish kaldır.
4. Anlık'ta yeni event'ler `pending`, poller hemen pick eder.

Bu adım sırası **ayrı iki PR** veya **ayrı iki deploy** olarak çalıştırılır:
- **PR-C1**: poller bring-up + feature flag (yazım davranışı değişmez).
- **PR-C2**: shadow→pending + direct publish disable.

---

## 3. Failure & Backoff

### 3.1 Backoff schedule

PR-A locked (REQUIREMENTS-OUTBOX-DLQ-V1.md §6):
- `BACKOFF_BASE_MS = 5_000` (5 sn)
- `MAX_ATTEMPTS = 5`
- Exponential: 5s, 10s, 20s, 40s, 80s — cap **30 dk**
- 5. attempt sonrası → `dead`

### 3.2 Concurrency safety

- `FOR UPDATE SKIP LOCKED` ile multi-instance worker safe.
- `BCMS_BACKGROUND_SERVICES=outbox-poller` — sadece worker container'ında çalışır (api container HTTP only). Tek worker container → SKIP_LOCKED gerekli değil ama future-proof.

### 3.3 Idempotency duplicate guard (cross-producer)

Phase 2'de `idempotency_key` set edilmiş satırlar (`ingest.job_completed`):
- Aynı key ile iki üretici → tek satır (DB partial unique).
- Poller bu satırı tek defa pick eder, tek defa publish.
- Phase 3'te direct publish kaldırılınca → Avid callback + Node worker iki defa direct publish edemez (hiç direct publish yok); poller'ın tek publish'i tek event yayar.

**PR-C smoke check**: Cut-over öncesi `outbox_events` tablosunda duplicate `idempotency_key` arama (olmamalı; varsa partial unique kırılmış demektir):

```sql
SELECT idempotency_key, COUNT(*)
FROM outbox_events
WHERE idempotency_key IS NOT NULL
GROUP BY idempotency_key
HAVING COUNT(*) > 1;
```

Sıfır satır beklenir.

---

## 4. Direct Publish Disable Planı

### 4.1 Disable yöntemi

Service'lerde direct publish çağrıları **silinmez**, **koşullu skip** edilir + domain bazında log (§10.1):

```typescript
// Phase 3 cut-over (PR-C2):
if (!process.env.OUTBOX_POLLER_AUTHORITATIVE) {
  await app.rabbitmq.publish(QUEUES.X, payload);
} else {
  app.log.debug({ domain: 'schedule', queue: QUEUES.X, eventType: 'schedule.created' },
    'direct publish skipped — outbox poller authoritative');
}
```

Default `OUTBOX_POLLER_AUTHORITATIVE=true` production; rollback için env false → direct publish revive (Phase 2'ye döner).

**Phase 4 (PR-D)**: Bu koşul tamamen silinir, kod tek path = outbox.

### 4.2 Yer listesi (cut-over scope)

`grep -rn "rabbitmq.publish" apps/api/src/modules` — 8 publish call site (Phase 2 inventory ile aynı):

| # | Site | Queue | Kontrol |
|---|---|---|---|
| 1 | `schedule.service.ts:create()` | `queue.schedule.created` | env-gated |
| 2 | `schedule.service.ts:update()` | `queue.schedule.updated` | env-gated |
| 3 | `booking.service.ts:create()` | `queue.booking.created` | env-gated |
| 4 | `booking.service.ts:update()` | `queue.notifications.email` | env-gated |
| 5 | `ingest.watcher.ts` | `queue.ingest.new` | env-gated |
| 6 | `ingest.service.ts:triggerManualIngest()` | `queue.ingest.new` | env-gated |
| 7 | `ingest.service.ts:finalizeIngestJob()` | `queue.ingest.completed` | env-gated |
| 8 | `ingest.service.ts:processIngestCallback()` | `queue.ingest.completed` | env-gated |

Hepsi tek bir env flag (`OUTBOX_POLLER_AUTHORITATIVE`) altında.

### 4.3 Notification consumer ne olacak?

`notification.consumer.ts` queue'dan tüketmeye devam eder; kaynak farkını bilmez (poller mı service mi publish etti). Tek değişen: in-memory dedup cache'in eventId'leri her iki fazda da v4, davranış sürekli.

---

## 5. Domain Bazlı Cut-over Sırası

Tüm domain'leri **tek deploy** ile cut-over yerine, **risk-azaltma için fazlı**:

| Sıra | Domain | Gerekçe | Smoke window |
|---|---|---|---|
| 1 | **Notification** | En düşük blast radius (sadece email; gecikme tolere edilir) | 30 dk |
| 2 | **Schedule** | Mevcut consumer yok (henüz); shadow only verify | 30 dk |
| 3 | **Booking** | Notification flag'i sonrası; aynı queue'lar | 30 dk |
| 4 | **Ingest INGEST_NEW** | Worker bağımlı; gecikme = ingest job processing delay | 1 saat |
| 5 | **Ingest INGEST_COMPLETED** | İdempotency key kritik; cross-producer dedup test edilmiş | 1 saat |

**Pratik:** Bu sıralama tek `OUTBOX_POLLER_AUTHORITATIVE` flag ile değil, **per-domain** flag setiyle (`OUTBOX_AUTHORITATIVE_DOMAINS=notification,schedule,booking,ingest_new,ingest_completed`) kontrol edilir. Her domain için ayrı smoke window.

**Alternatif (basit, riskli):** Tek flag, tek-shot cut-over. Production'da test edilecekse her şey aynı anda; rollback flag false. Bu version V1 default — domain-by-domain karmaşıklık V2.

**V1 default karar:** Tek flag, tek-shot cut-over (basit). Per-domain pencere V2 ihtiyaç olursa.

---

## 6. Smoke Checks (Cut-over öncesi/sonrası)

### 6.1 Pre-cut-over (PR-C2 deploy öncesi)

1. **Phase 2 shadow sağlığı:**
   ```sql
   SELECT event_type, COUNT(*) FROM outbox_events GROUP BY event_type;
   ```
   Bekleme: tüm event tipleri için >0 row (Phase 2 yazıyor).

2. **Idempotency key duplicate yok:**
   ```sql
   SELECT idempotency_key, COUNT(*) FROM outbox_events
   WHERE idempotency_key IS NOT NULL
   GROUP BY idempotency_key HAVING COUNT(*) > 1;
   ```
   Sıfır satır.

3. **Pending lag yok (PR-C1 sonrası):**
   ```sql
   SELECT COUNT(*) FROM outbox_events WHERE status='pending';
   ```
   Sıfır (cut-over öncesi shadow `published` yazıyor; pending ortaya çıkması = code drift).

### 6.2 Post-cut-over (PR-C2 deploy sonrası)

1. **Poller pickup:** İlk event yazımından sonra ≤5 sn `published` olur.
2. **Failed/dead alarm:** `bcms_outbox_failed_count`, `bcms_outbox_dead_count` 0 kalmalı (alert kuralları PR-A §7.3).
3. **Pending lag:** `bcms_outbox_oldest_pending_age_seconds` < 30 sn (poller healthy).
4. **End-to-end:** Test booking create → notification email arrive (consumer dedup üzerinden geçer; tek email).

### 6.3 Smoke automation

Smoke check script: **`ops/scripts/check-outbox-cutover.mjs`** (Node, karar 3 §10).

- CLI: `node ops/scripts/check-outbox-cutover.mjs --phase=pre|post [--json]`
- Kaynaklar:
  - DB: Prisma client (idempotency duplicate, pending lag, event_type breakdown)
  - Prometheus: `bcms_outbox_failed_count`, `bcms_outbox_dead_count`, `bcms_outbox_oldest_pending_age_seconds`
- Output: human-readable çıktı (default) veya `--json` ile structured (CI/runbook integration için).
- Exit code: 0 (tüm kontroller PASS), 1 (en az bir FAIL).

Bash yerine Node tercih edildi çünkü multi-source (DB + Prometheus) JSON aggregation ve typed Prisma query'leri daha temiz.

---

## 7. Rollback Runbook

`ops/RUNBOOK-OUTBOX-POLLER-ROLLBACK.md` (PR-C ile birlikte teslim edilir).

### 7.1 Rollback tetikleyiciler

- Failed/dead alarm 5 dk içinde (production traffic'inde anormal).
- Notification email duplicate raporu.
- End-to-end smoke check post-cut-over fail.

### 7.2 Rollback adımları (azalan severity)

**Soft rollback (PR-C2 davranışı geri):**
1. `OUTBOX_POLLER_AUTHORITATIVE=false` env set.
2. `docker compose up -d --build api worker` (env reload).
3. Direct publish revive olur; poller hâlâ çalışır ama event yazımları `published` ile gelmediğinden pick etmez.
4. **Sonuç:** Phase 2 shadow mode (mevcut son shadow PR sonrası davranış).

**Hard rollback (PR-C2 commit revert):**
1. Git revert PR-C2 commit; PR-C1 commit kalır (poller hâlâ aktif ama `pending` event yok).
2. Production deploy.
3. Aynı sonuç: Phase 2 davranışı.

**Nuclear rollback (poller'ı tamamen disable):**
1. `BCMS_BACKGROUND_SERVICES` listesinden `outbox-poller` çıkar.
2. Worker container restart.
3. Direct publish env-gated yine kontrol edilir; gerekirse Phase 1'e dönülür.

### 7.3 Post-rollback investigation

- `outbox_events` tablosunda `failed`/`dead` satırlar incelenir.
- Consumer-side log (notification, ingest) duplicate event tespiti.
- Production RMQ queue length izlenir (anormal birikim?).

---

## 8. Test Stratejisi (PR-C1 + PR-C2)

### PR-C1 (poller bring-up)

- Unit/integration test: `outbox.poller.ts`
  - Pending event pick → publish → status update (mock RabbitMQ).
  - Publish failure → status='failed' + backoff next_attempt.
  - MAX_ATTEMPTS reached → status='dead'.
  - SKIP LOCKED concurrency (iki tx aynı event pick etmez).
  - DRY_RUN env: status değişmez, sadece log.

### PR-C2 (shadow→pending + direct disable)

- Existing service spec'lerini **iki mod ile koş**:
  - `OUTBOX_POLLER_AUTHORITATIVE=undefined` (default eski) → shadow `published`, direct publish var.
  - `OUTBOX_POLLER_AUTHORITATIVE=true` (cut-over) → shadow `pending`, direct publish yok.
- Cross-source dedup test (PR-B3b-2 var) — cut-over modunda da geçer.
- End-to-end (yeni): poller process içinde gerçek publish + consumer dedup → tek email.

---

## 9. PR Sıralaması

Uygulama planı:

```
PR-C1 — Poller bring-up (Phase 3 öncesi enable):
  ├─ apps/api/src/modules/outbox/outbox.poller.ts (background service)
  ├─ BCMS_BACKGROUND_SERVICES'a 'outbox-poller' ekle
  ├─ Feature flag env: OUTBOX_POLLER_ENABLED (default false in PR-C1; true in cut-over deploy)
  ├─ Test: poller state machine (pick/publish/failed/dead/SKIP_LOCKED)
  ├─ Smoke check script (pre-cut-over)
  ├─ Production deploy → poller live; pending=0 (henüz yazımlar 'published')
  └─ Soak window: ≥1 saat metric/log gözlemi

PR-C2 — Shadow→pending + direct publish disable:
  ├─ outbox.helpers.ts: shadow status default 'pending' (writeShadowEvent default change)
  ├─ Direct publish 8 site env-gated (OUTBOX_POLLER_AUTHORITATIVE=true skip)
  ├─ Test: existing spec'leri iki mod ile (env toggle)
  ├─ End-to-end test: poller process'te publish + consumer dedup
  ├─ Smoke check script (post-cut-over)
  ├─ Rollback runbook (`ops/RUNBOOK-OUTBOX-POLLER-ROLLBACK.md`)
  └─ Production deploy → cut-over canlı

PR-D — Cleanup + replay:
  ├─ Direct publish kod tabanından sil
  ├─ Admin endpoint /admin/outbox + replay
  ├─ Outbox retention (published 30 gün PR-A locked)
  └─ Dashboard / alert tuning
```

---

## 10. Açık Kararlar — kapatıldı (2026-05-06)

| # | Karar | V1 |
|---|---|---|
| 1 | **Per-domain vs tek flag** | **Tek global flag** (`OUTBOX_POLLER_AUTHORITATIVE=true`). Direct publish skip branch'leri **domain bazında loglamalı** (debug/audit izlenebilirlik). Per-domain flag V2 ihtiyaç olursa. |
| 2 | **Notification consumer dedup** | **Drain önce + maintenance window** kabul edilebilir minimum. PR-C2 deploy öncesi `pending=0` smoke gerekir. Deploy penceresinde **kısa duplicate email riski gerçek** — runbook **warning** olarak yazılır. Restart-safe persistent dedup PR-D sonrası ayrı PR. |
| 3 | **Smoke automation** | **Node script**: `ops/scripts/check-outbox-cutover.mjs`. DB query + Prometheus metric fetch + JSON output. Bash daha az anlamlı (multi-source). |
| 4 | **Backoff jitter** | V1'de **YOK**. Tek worker instance varsayımı (`BCMS_BACKGROUND_SERVICES=outbox-poller` sadece worker container'ında). Multi-worker'a geçerse jitter eklenir; V2 scope. |

### 10.1 Per-domain log convention (karar 1 detayı)

Direct publish skip branch'i (PR-C2'de §4.1):

```typescript
if (!process.env.OUTBOX_POLLER_AUTHORITATIVE) {
  await app.rabbitmq.publish(QUEUES.X, payload);
} else {
  app.log.debug({ domain: 'schedule', queue: QUEUES.X, eventType: 'schedule.created' },
    'direct publish skipped — outbox poller authoritative');
}
```

8 site için aynı pattern (domain string her site'da farklı: `schedule`, `booking`, `notification`, `ingest_started`, `ingest_completed`).

### 10.2 Maintenance window protokolü (karar 2 detayı)

PR-C2 deploy öncesi runbook adımı (RUNBOOK-OUTBOX-POLLER-ROLLBACK.md ile birlikte teslim):

1. **Pre-drain check**: `outbox_events WHERE status='pending'` count = 0 (Phase 2 hâlâ `'published'` yazıyor; `pending` görülmemeli).
2. **Maintenance flag**: kullanıcı-yüzü write trafiği (booking create, schedule update, manual ingest) ≤2 dk durdurulur (UI banner veya rate-limit bypass kapalı).
3. **In-flight drain**: RabbitMQ queue length sıfır beklenir (notification consumer in-memory cache hot kalır; restart kaçınılır).
4. **Deploy PR-C2**: `docker compose up -d --build api worker` — `OUTBOX_POLLER_AUTHORITATIVE=true` ile.
5. **Post-deploy smoke**: §6.2 listesi.
6. **Maintenance flag kapat**: write trafiği geri açılır.

**Runbook warning (kelime kelime ekle):**

> ⚠️ **Cut-over penceresinde duplicate notification email riski mevcuttur.** Notification consumer in-memory dedup cache (Set<eventId>) consumer restart sırasında boşalır. Cut-over deploy maintenance penceresinde consumer restart kaçınılırsa bu risk minimize edilir; yine de kullanıcılar nadir bir senaryoda iki kez aynı email alabilir. Restart-safe dedup PR-D sonrası ayrı PR'da gelir.

---

**Maintainer**: kullanıcı (osmanbaskan)
**Implementer**: Claude (PR-C1 talep edildiğinde + açık kararlar netleşince)
