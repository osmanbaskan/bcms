# INGEST_COMPLETED Authoritative Producer — Karar Notu

> **Status**: 🟡 Direction decided; sub-option **B2** selected; implementation pending. PR-B3b-2 prerequisite.
> **Tarih**: 2026-05-06
> **Bağlam**: Madde 2+7 (Outbox + DLQ) PR-B3b-1 kapanış; INGEST_COMPLETED shadow yazımı duplicate-completion guard olmadan Phase 3'te risk.
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 2 + 7.

## 1. Problem

`queue.ingest.completed` queue'sundan iki ayrı kod yolu publish yapıyor:

| # | Konum | Trigger | Tx flow |
|---|---|---|---|
| W1 | `apps/api/src/modules/ingest/ingest.worker.ts:233` | Worker COMPLETED branch — proxy + QC bitti | `ingestJob.update(COMPLETED)` → `rabbitmq.publish(INGEST_COMPLETED, status='COMPLETED')` |
| W2 | `apps/api/src/modules/ingest/ingest.worker.ts:249` | Worker FAILED branch — exception path | `ingestJob.update(FAILED)` → `rabbitmq.publish(INGEST_COMPLETED, status='FAILED')` |
| C  | `apps/api/src/modules/ingest/ingest.routes.ts:761` | POST `/webhooks/ingest/callback` (HMAC `requireWorkerSecret`) | `ingestJob.update(...)` + opsiyonel `qcReport.upsert()` + `ingestPlanItem.updateMany()` → `rabbitmq.publish(INGEST_COMPLETED, status=dto.status)` |

**Eğer iki yol da aktif** → aynı `jobId` için iki INGEST_COMPLETED publish edilir. Phase 2'de görünmez (queue consumer yok), ama Phase 3 cut-over'da poller'a geçildiğinde:

- `outbox_events`'e iki satır yazılır → poller iki defa publish eder
- Idempotency anchor (eventId UUID v4) farklı olduğu için consumer-side dedup tek başına çözmez; **aggregate-level idempotency key** gerekir

## 2. Mevcut Durum (read-only verify)

### 2.1 Repo'da callback caller arandı

```
grep -rn "ingest/callback\|INGEST_CALLBACK_SECRET" \
  --include="*.ts" --include="*.py" --include="*.sh" \
  --include="*.yml" --include="*.yaml" /home/ubuntu/Desktop/bcms
```

Bulgular:
- **Endpoint tanımlı**: `ingest.routes.ts:690` (HMAC `requireWorkerSecret`)
- **Secret konfigüre**: `.env.example:50`, `docker-compose.yml:163,227`, `app.ts:73` validation, `.github/workflows/ci.yml:55`, `RUNBOOK-SECRETS-ROTATION.md`
- **Caller yok (şu an)**: Repo içinde HTTP POST atan hiçbir kod yok — Python/Node/shell. External worker dokümantasyonu da yok.

### 2.2 Worker authoritative path (gerçek production yolu)

`docker-compose.yml:216`:
```
BCMS_BACKGROUND_SERVICES: notifications,ingest-worker,ingest-watcher,audit-retention,audit-partition,outbox-poller
```

→ `ingest-worker` (Node, in-process) worker container'ında **canlı** ve `INGEST_COMPLETED`'i kendisi publish ediyor (W1/W2). Callback'i çağırmıyor.

### 2.3 Kullanıcı teyidi (2026-05-06)

> **Avid capture entegrasyonu yakın zamanda tamamlanacak; bu endpoint o entegrasyon için kullanılacak.**

→ Callback **dead code DEĞİL**; future-active. Avid capture worker'ı (BCMS dışı, harici sistem) bu endpoint'i çağırarak ingest tamamlanma sinyali verecek. Sonuç:

- Worker (W1/W2) **canlı** üretici — Node in-process worker (FFmpeg-tabanlı dahili pipeline).
- Callback (C) **canlı-olacak** üretici — Avid capture entegrasyonu sonrası.
- İki üretici **aynı domain event'ini** (INGEST_COMPLETED) farklı job'lar için (veya aynı job'ın farklı senaryolarında) yayımlar.

**Kritik soru:** Aynı `jobId` iki üretici tarafından completed işaretlenebilir mi?
- Tipik akış: Bir job ya Node worker tarafından işlenir (FFmpeg path) ya Avid capture tarafından (Avid path). Aynı job iki path'ten geçmemeli.
- Ancak edge case: Recovery, manual re-trigger, race kondition → aynı `jobId` için iki completion sinyali olabilir.
- **Garanti vermek için idempotency key zorunlu.**

## 3. Yön: Opsiyon B (idempotency key — onaylandı)

İki üretici aktif kalır. Outbox shadow'da aggregate-level idempotency key uygulanır.

**Idempotency key formülü:**

```
ingest.job_completed:IngestJob:{jobId}:{terminalStatus}
```

- `jobId`: integer
- `terminalStatus`: `COMPLETED` | `FAILED` (sadece terminal status'lar — intermediate `PROCESSING`/`PROXY_GEN`/`QC` shadow YAZMAZ; aşağıda §4 not)
- Kaynak (worker vs callback) key'e dahil edilmez → ilk yazan kazanır, ikincisi quiet skip

**Davranış garantisi:**
- Worker COMPLETED + callback COMPLETED aynı `jobId` için → tek outbox satırı.
- Worker FAILED + callback COMPLETED aynı `jobId` için → iki outbox satırı (terminal status farklı).
  - Bu **doğru davranış** mı? — § 5.3'te tartışılıyor; şimdilik "evet, iki ayrı domain event sayılır" varsayımı.

## 4. Scope Kararı: Hangi Status'lar Shadow Yazar?

Callback (C) `dto.status` olarak intermediate (`PROCESSING`, `PROXY_GEN`, `QC`) da kabul ediyor (line 761). Worker sadece `COMPLETED`/`FAILED` publish ediyor. Tutarlılık için:

- **Sadece terminal status'lar** (`COMPLETED`, `FAILED`) outbox shadow yazar (eventType = `ingest.job_completed`).
- Intermediate status'lar yalnız direct publish (mevcut davranış); outbox tarihçesinde yer almaz.
- Gerekçe:
  - Worker'ın intermediate publish'i yok → parity için intermediate shadow da yok.
  - Domain event semantiği "completion"; intermediate "progress signal" — farklı concern, farklı PR.
  - Phase 3'te poller intermediate'ı işlemez (downstream consumer terminal'i bekliyor).

## 5. Implementation Alt-Tasarımları (sub-options — kullanıcı seçimi bekliyor)

İdempotency key'in DB seviyesinde uygulanması üç farklı yolla mümkün:

### 5.1 Sub-Option B1 — UUID v5 deterministic eventId

- `eventId` UUID v5 (namespace-name) ile deterministic üretilir: `uuidv5(NAMESPACE_INGEST_COMPLETED, "ingest.job_completed:IngestJob:{jobId}:{terminalStatus}")`
- Mevcut `event_id UNIQUE` constraint'i kullanır → schema değişmez
- INSERT ON CONFLICT skip via Prisma `createMany({ skipDuplicates: true })` veya raw SQL

**Pros:**
- Schema migration yok (en küçük değişiklik).

**Cons:**
- `outbox_events.event_id` kolonunda v4 + v5 karışık olur; `isValidEventId()` regex (`outbox.types.ts:59`) v4-only — güncellenmesi gerekir.
- Consumer (Phase 3 poller veya downstream) eventId'nin v4 olduğunu varsayarsa kırılabilir.
- "Random" ile "deterministic" eventId aynı kolonda → semantic karışıklık.

### 5.2 Sub-Option B2 — Yeni `idempotency_key` kolonu

- `outbox_events` tablosuna yeni kolon: `idempotency_key VARCHAR(160) NULL UNIQUE WHERE NOT NULL` (partial unique index — opsiyonel kolon, sadece dedup gereken eventler için).
- `eventId` her zaman v4 random kalır.
- `writeShadowEvent` opsiyonel `idempotencyKey` alır; varsa `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`.

**Pros:**
- Temiz separation: eventId her zaman random, idempotency key explicit string.
- Consumer eventId varsayımları kırılmaz.
- Diğer domain event'lerde (notification, schedule) idempotency gerekirse aynı pattern.

**Cons:**
- Schema migration (PR-A v2 mantığı; küçük ama Madde 4 interim helper'a benzer geçici durum).
- Helper API genişler (opsiyonel parametre).

### 5.3 Sub-Option B3 — Application-side SELECT-then-INSERT

- writeShadowEvent SELECT yapar (eventType+aggregateId+payload->status); satır varsa skip.
- Schema değişmez.

**Pros:**
- En küçük teknik kapsam.

**Cons:**
- **Race condition**: İki paralel completion (worker + callback aynı anda) — ikisi de SELECT'te boş bulur, ikisi de INSERT eder → duplicate.
- Mitigation için advisory lock veya SERIALIZABLE tx gerekir → karmaşıklık artar.
- DB-level guarantee yok; her caller helper'ı doğru kullanmak zorunda.

### 5.4 Seçim: B2 (kullanıcı kararı 2026-05-06)

- Race-condition güvenli (DB UNIQUE — partial unique index).
- `eventId` her zaman UUID v4 kalır → semantic temiz; consumer varsayımları korunur.
- Callback + worker aynı terminal event'i aynı anda üretirse duplicate outbox satırı DB seviyesinde engellenir.
- Audit doc disiplini ile uyumlu (Madde 4 interim helper pattern + production migration).
- Future-proof: Diğer domain'lerde (notification email retry, schedule update collision) gerekirse aynı kolon kullanılabilir.
- B3 race-condition garantisi vermediği için, B1 eventId semantiğini kirlettiği için reddedildi.

## 6. Phase 3 Cut-over Guard

Karar/sub-option ne olursa olsun PR-C (poller enable) öncesinde:
- `outbox_events`'te `eventType='ingest.job_completed'` için duplicate satır yokluğu smoke test (idempotency key working).
- Direct publish disable edilirken **önce** poller test edilmeli (replay UI / metrics ile dedupe verify).
- Cut-over rollback path'i RUNBOOK'ta belgele (worker direct publish re-enable).

## 7. Yapılacaklar (post-decision)

- [x] Kullanıcı teyidi: callback canlı mı? → **Evet, Avid capture entegrasyonu için planlanıyor.**
- [x] Yön: **Opsiyon B (idempotency key)** seçildi.
- [x] Sub-option: **B2 (idempotency_key kolonu + partial unique index)** seçildi (2026-05-06).
- [ ] **Schema PR (B3b-2 öncesi prerequisite)** — küçük dar PR:
  - `outbox_events.idempotency_key VARCHAR(160) NULL`
  - Partial unique index: `WHERE idempotency_key IS NOT NULL`
  - Prisma model güncelleme + `@@unique([idempotencyKey], map: "...")` veya `@@index` partial declaration (Prisma 5 native partial UNIQUE desteği sınırlı → migration SQL + raw `db push` kombinasyonu; Madde 4 helper pattern aynısı).
  - Test setup'ta constraint/index reapply (Madde 4 + PR-A interim helper'ları gibi).
  - `writeShadowEvent` API genişletme (opsiyonel `idempotencyKey` parametresi; INSERT ... ON CONFLICT DO NOTHING semantik).
- [ ] PR-B3b-2 implementasyonu — schema PR sonrası:
  - Worker (W1/W2) outbox shadow + idempotency key.
  - Callback (C) outbox shadow + aynı idempotency key (parity).
  - Sadece terminal status (COMPLETED/FAILED) shadow yazar.
  - Test: aynı `jobId` için W1 + C çağrısı → tek outbox satırı; farklı terminal status → iki satır.
- [ ] Audit doc Madde 2 + Madde 7 state sync.

## 8. Avid Capture Entegrasyon Notu

Avid capture worker'ı production'a alındığında:
- Avid worker BCMS API'ye `POST /api/v1/ingest/callback` atar (HMAC `INGEST_CALLBACK_SECRET`).
- Aynı job için Node worker pipeline'ından geçilmeyeceği varsayılıyor (job source belirleyici — Avid path mı FFmpeg path mı).
- Eğer iki path aynı job için tetiklenirse idempotency key DB-level dedup garanti eder.
- Avid integration testi (post-PR-B3b-2): aynı `jobId` için worker + callback çağrılır → tek outbox satırı assert.

---

**Maintainer**: kullanıcı (osmanbaskan)
**Implementer**: Claude (PR-B3b-2 talep edildiğinde + sub-option seçimi sonrası)
