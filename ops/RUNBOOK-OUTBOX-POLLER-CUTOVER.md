# Outbox Poller Cut-over Runbook

**Tasarım**: `ops/REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md`
**PR'lar**: PR-C scope doc (`4d85bb1`), PR-C1 poller bring-up (`a25efb6`); **PR-C2 (cut-over) production soak gate pending**.
**Smoke script**: `ops/scripts/check-outbox-cutover.mjs`
**Versiyon**: 1.0 (2026-05-06)

Bu runbook PR-C2 cut-over'ı **production'a deploy** etmek için adım sırasıdır. PR-C2 kodu **henüz main'de değil** — production PR-C1 soak yeşil olduktan sonra hazırlanır + merge edilir + deploy edilir.

> **Kritik kural**: PR-C2 cut-over davranışı `OUTBOX_POLLER_AUTHORITATIVE=true` ile tetiklenir. Bu env false olsa bile **kodun davranış yüzeyi** PR-C2 sonrası değişir (shadow yazımı `'pending'`). Bu yüzden PR-C2 production soak sonucu olmadan main'e girmemelidir.

---

## 0. Production Cut-over Ready Gate

PR-C2 PR'ını **açmadan önce** aşağıdakilerin **production'da** doğrulanmış olması zorunludur:

### 0.1 Pre-req checklist (production)

- [ ] PR-C1 commit `a25efb6` production worker image'ında.
- [ ] `OUTBOX_POLLER_ENABLED=true` worker container env'de.
- [ ] `docker compose up -d --build worker` ile reload yapıldı.
- [ ] **Soak window ≥ 1 saat** geçti (poller idle koşar; pending=0 invariant korunur çünkü Phase 2 yazımları `'published'`).
- [ ] Worker logs temiz:

  ```bash
  docker logs bcms_worker_1 2>&1 | grep -i "outbox poller" | tail -20
  ```
  Bekleme: yalnız "Outbox poller starting" + (varsa) "Outbox poller tick picked=0..." kayıtları. **Hiçbir** error/crash log'u olmamalı.
- [ ] Pre-cut-over smoke yeşil:

  ```bash
  node ops/scripts/check-outbox-cutover.mjs --phase=pre
  ```
  Tüm PASS. Çıktı:
  - `event_type_breakdown`: PASS — tüm 6 known event tipi >0 satır (Phase 2 shadow yazılıyor).
  - `idempotency_duplicates`: PASS — partial unique sağlam.
  - `no_pending_backlog`: PASS — `pending=0`.

### 0.2 Gate başarısız olursa

| Bulgu | Aksiyon |
|---|---|
| Poller logs'da error | PR-C1 implementasyon hatası → fix PR + tekrar soak |
| `event_type_breakdown` WARN (eksik tip) | Phase 2 shadow yazılmıyor olabilir; service spec'i çalıştırarak event üret + tekrar smoke |
| `idempotency_duplicates` FAIL | Partial unique index kırılmış; migration `20260506000001_outbox_idempotency_key` re-apply gerek |
| `no_pending_backlog` FAIL | Phase 2 invariant bozulmuş; `writeShadowEvent` `'published'` yazıyor mu kontrol et |

Gate yeşil olmadan PR-C2 açma.

---

## 1. PR-C2 İçeriği (production soak sonrası hazırlanır)

PR-C2 **iki davranış değişikliğini** tek atomik commit'te yapar:

1. **`outbox.helpers.ts:writeShadowEvent`** default `status='pending'` (publishedAt=null) — Prisma create + raw INSERT path ikisi de.
2. **8 publish site env-gated skip** + per-domain debug log (`OUTBOX_POLLER_AUTHORITATIVE=true`):

   ```ts
   if (!process.env.OUTBOX_POLLER_AUTHORITATIVE) {
     await app.rabbitmq.publish(QUEUES.X, payload);
   } else {
     app.log.debug({ domain: 'X', queue: QUEUES.X, eventType: 'X' },
       'direct publish skipped — outbox poller authoritative');
   }
   ```

   Site listesi (REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md §4.2):
   - `schedule.service.ts:create()` → `queue.schedule.created`
   - `schedule.service.ts:update()` → `queue.schedule.updated`
   - `booking.service.ts:create()` → `queue.booking.created`
   - `booking.service.ts:update()` → `queue.notifications.email`
   - `ingest.watcher.ts` → `queue.ingest.new`
   - `ingest.service.ts:triggerManualIngest()` → `queue.ingest.new`
   - `ingest.service.ts:finalizeIngestJob()` → `queue.ingest.completed`
   - `ingest.service.ts:processIngestCallback()` → `queue.ingest.completed`

3. **Test mod toggle**: existing service spec'leri iki mod ile koş.
4. **End-to-end test**: poller process içinde gerçek publish + consumer dedup → tek email.

**PR-C2 main'e merge edildiğinde** kod davranışı:
- `OUTBOX_POLLER_AUTHORITATIVE` env unset → Phase 2 davranışı (shadow `pending` ama direct publish var). **PR-C1 invariant kırılır** (pending=0 olmaz). Bu yüzden PR-C2 deploy ile env'in **eş zamanlı** set edilmesi şarttır.

---

## 2. Cut-over Maintenance Window Protokolü

PR-C2 deploy adımları (REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md §10.2 detayı):

### 2.1 T-15 dk — pre-drain check

```bash
# Phase 2 invariant verify (pending=0 olmalı):
psql -c "SELECT COUNT(*) FROM outbox_events WHERE status='pending';"

# Idempotency key duplicate yok:
node ops/scripts/check-outbox-cutover.mjs --phase=pre
```

Pending > 0 ise PR-C2 ASLA deploy edilmez (kod main'e merge edilmiş olsa bile env false bırakılır + investigation).

### 2.2 T-5 dk — maintenance flag

- UI banner: "Sistem bakımda — yazma işlemleri 2 dk kısıtlı."
- Veya rate-limit aggressive (POST/PATCH 429) — write trafiği ≈0'a iner.
- Notification consumer **restart edilmez** (in-memory dedup cache hot kalır).

### 2.3 T-2 dk — RMQ queue drain

```bash
# Tüm domain queue'ları boş bekle:
docker exec bcms_rabbitmq rabbitmqctl list_queues name messages | grep "^queue\."
```

In-flight mesajlar consumer tarafından işlensin.

### 2.4 T-0 — deploy PR-C2

```bash
cd /opt/bcms
git pull origin main   # PR-C2 commit'i içerir
# Worker container env'inde OUTBOX_POLLER_AUTHORITATIVE=true ekle
# .env veya docker-compose.override.yml'de set
docker compose up -d --build api worker
```

### 2.5 T+2 dk — post-cut-over smoke

```bash
# Test write trafiği (write traffic geri açıldı mı kontrol; manuel curl ile):
curl -X POST ... /api/v1/bookings ...   # bir booking create → notification flow

# Smoke check post:
node ops/scripts/check-outbox-cutover.mjs --phase=post
```

Beklenen:
- `no_failed`: PASS (failed=0)
- `no_dead`: PASS (dead=0)
- `pending_lag`: PASS (oldest_pending_age ≤ 30s)

Worker logs:

```bash
docker logs bcms_worker_1 --since 5m | grep -i "outbox"
```
Bekleme: "Outbox poller tick picked=N published=N" satırları (write trafiği üretildiyse N>0).

### 2.6 T+5 dk — maintenance flag kapat

Write trafiği geri açılır.

### 2.7 T+1 saat — soak monitor

- `bcms_outbox_failed_count` Prometheus alarm 0 kalmalı.
- `bcms_outbox_dead_count` 0 kalmalı.
- `bcms_outbox_oldest_pending_age_seconds` ≤ 30s.
- (Manuel: kullanıcı email duplicate raporu yok — destek ekibi pencerelendir.)

---

## 3. ⚠️ Cut-over Penceresinde Duplicate Notification Email Riski

> **UYARI**: Cut-over deploy maintenance penceresinde **duplicate notification email** riski mevcuttur.
>
> - Notification consumer (`apps/api/src/modules/notifications/notification.consumer.ts`) şu an **persistent dedup'a sahip değil**; consumer-internal retry mekanizması yalnız `_meta.retries` counter ile çalışır.
> - Cut-over deploy worker container'ı yeniden başlatır (`docker compose up -d --build worker`). Bu sırada notification consumer'ın in-memory davranışı resetlenir.
> - **Race penceresi**: Phase 2 son saniyede yazılan ve direct publish edilen bir email, RMQ queue'da consume edilemeden cut-over olursa, PR-C2 sonrası poller aynı outbox satırını (Phase 2'de `published` yazıldığı için) pick etmez — bu **safe**. AMA Phase 2 direct publish + cut-over deploy arasında consumer henüz mesajı işlemediyse, consumer restart sonrası RMQ aynı mesajı yeniden teslim eder → tek email (duplicate yok).
> - Asıl risk daha subtle: cut-over deploy adımının **tam ortasında** bir booking update fırlatılırsa (maintenance flag rağmen), shadow yazımı `pending` (PR-C2 davranışı) olabilir AMA aynı çağrı direct publish'i de tetikleyebilir (env race) → **iki publish**. Consumer iki email gönderir.
>
> **Mitigasyon**:
> - Maintenance window'da write trafiği aggressive kısıtlanır (§2.2).
> - Pre-drain RMQ queue boş (§2.3).
> - **Restart-safe persistent dedup** (V2 scope) bu riski tamamen kapatır; PR-D sonrası ayrı PR'da ele alınır.
> - Bu pencereDe **kullanıcılar nadir senaryoda iki kez aynı email** alabilir; kabul edilebilir minimum risk.

---

## 4. Rollback (3 katman)

REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md §7 detayı.

### 4.1 Soft rollback (env değişikliği — en hızlı)

Tetikleyici: failed/dead alarm 5 dk içinde, duplicate email rapor.

```bash
# Worker env: OUTBOX_POLLER_AUTHORITATIVE değerini false'a çek (veya unset).
# .env veya docker-compose.override.yml düzelt.
docker compose up -d --build worker
```

Sonuç: direct publish revive olur; poller hâlâ çalışır ama yeni event'ler `pending` yazıldığı için iki kaynaktan publish var → **kısa duplicate publish** penceresi açılır. Consumer dedup yoksa email duplicate gelir. Hızlı çözüm: §4.3 nuclear ile poller'ı da disable et.

⚠️ Aslında soft rollback **tek başına yeterli değil** — shadow yazımı `'pending'` kalır (kod davranışı), poller hâlâ pick eder, direct publish de happen eder. **Kombineli çözüm**: §4.3 + nuclear.

### 4.2 Hard rollback (commit revert)

```bash
git revert <PR-C2-commit-sha>   # main'e revert commit
git push origin main
docker compose up -d --build api worker
```

Sonuç: shadow yazımı `'published'`'a döner; direct publish unconditional. Phase 2 davranışı.

### 4.3 Nuclear rollback (poller disable + revert)

```bash
# Worker env: OUTBOX_POLLER_ENABLED=false
docker compose up -d --build worker

# Sonra commit revert:
git revert <PR-C2-commit-sha>
git push origin main
docker compose up -d --build api worker
```

Sonuç: Phase 1 davranışı (poller yok + direct publish var). En güvenli rollback.

### 4.4 Post-rollback investigation

- `outbox_events` tablosunda `failed`/`dead` satırlar incelenir.
- Notification consumer log'unda duplicate email tespiti.
- RMQ queue length anormal birikim?
- Dead satırlar manuel SQL replay ile `pending`'e taşınabilir (PR-D admin endpoint'i öncesi):

  ```sql
  UPDATE outbox_events
  SET status='pending', attempts=0, next_attempt_at=NOW(), last_error=NULL
  WHERE status='dead' AND id IN (...);
  ```

---

## 5. Smoke Komutları (referans)

### Pre-cut-over

```bash
node ops/scripts/check-outbox-cutover.mjs --phase=pre
node ops/scripts/check-outbox-cutover.mjs --phase=pre --json   # CI/automation
```

### Post-cut-over

```bash
node ops/scripts/check-outbox-cutover.mjs --phase=post
```

### Manuel SQL kontrolleri

```sql
-- Status breakdown
SELECT status, COUNT(*) FROM outbox_events GROUP BY status;

-- Oldest pending age
SELECT MIN(next_attempt_at), NOW() - MIN(next_attempt_at) AS age
FROM outbox_events WHERE status='pending';

-- Idempotency duplicate hunt (PR-B3b-2 invariant)
SELECT idempotency_key, COUNT(*)
FROM outbox_events
WHERE idempotency_key IS NOT NULL
GROUP BY idempotency_key HAVING COUNT(*) > 1;

-- Failed/dead drill-down
SELECT id, event_type, attempts, last_error, next_attempt_at
FROM outbox_events
WHERE status IN ('failed', 'dead')
ORDER BY id DESC LIMIT 20;
```

---

## 6. Öncesi/Sonrası State

| Metric / kontrol | Phase 2 (PR-C1 sonrası) | Phase 3 (PR-C2 sonrası) |
|---|---|---|
| Shadow status default | `'published'` + `publishedAt=NOW()` | `'pending'` + `publishedAt=NULL` |
| Poller pickup | Yok (idle) | Saniye içinde pick |
| Direct publish | Aktif | Env-gated skip (debug log) |
| `pending` count | 0 | < BATCH_SIZE * BATCH_TIME oran |
| `failed`/`dead` | 0 (alarm yok) | 0 (alarm) — RMQ healthy iken |
| Consumer behavior | Aynı | Aynı |
| Cut-over rollback | n/a | §4 (3 katman) |

---

**Maintainer**: kullanıcı (osmanbaskan)
**Implementer**: Claude (PR-C2 talep edildiğinde — production soak gate yeşil olduktan sonra)
