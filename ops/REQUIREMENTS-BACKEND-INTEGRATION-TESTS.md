# Backend Integration Test Foundation — Tasarım Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Bu doküman scope + araç seçimi + ilk PR çıktısını netleştirir; implementation ayrı PR.
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 8 (skip listesi). `apps/api/src/` altında 0 gerçek test (`notification.test.ts` demo).
> **Pattern referansı**: `ops/REQUIREMENTS-MAINTENANCE-PATTERN.md`, `ops/REQUIREMENTS-NOTIFICATION-DELIVERY.md` — design-first, decisions-pending yapısı.

## Amaç

Refactor + migration + outbox/DLQ gibi sonraki tüm mimari maddeler test güvencesi olmadan riskli. Bu doc:

1. Test stack ve tooling seçimini sabitler.
2. İlk PR'ın **dar kapsamı** (3 critical-path spec) belirler.
3. CI entegrasyonunu, DB lifecycle'ını ve geliştirici workflow'unu netleştirir.
4. Acceptance criteria koyar — başarı ölçülebilir olur.

> **Out of scope (bu doc):** test kütüphane karşılaştırması beyond Vitest, mock vs real network kararı beyond DB+RMQ, frontend test stratejisi, performance/load test.

---

## 1. Mevcut Durum (read-only verify)

### Test ayak izi

| Dosya | Tür | Durum |
|---|---|---|
| `apps/api/src/modules/notifications/notification.test.ts` | Demo script (Vitest değil) | Fonksiyonel; smoke amaçlı |
| `apps/web/src/**/*.spec.ts` (7 dosya) | Karma + Jasmine | Component-render testleri |
| `tests/playwright/*.spec.ts` (4 dosya) | Playwright E2E | UI flow + visual regression |
| `apps/api` Vitest config | — | **Yok** |
| `apps/api` test runner script | — | `package.json` `lint` var, `test` yok |

### Mevcut prisma migration toolu

`apps/api/prisma/migrations/` (~20 migration). `npx prisma migrate deploy` CI'da çalışıyor. Test DB için aynı migration set'i uygulanabilir (`migrate reset`).

---

## 2. Stack Seçimi

### Test runner: **Vitest**

- **Karşılaştırma**: Jest mevcut FE'de yok, sadece Karma/Jasmine var. Backend'e Jest eklemek ek dependency. Vitest:
  - TypeScript native (ts-node gerekmez; build yok)
  - ESM-first (BCMS api `"type": "module"`)
  - Hızlı (`vite`'in HMR mantığı)
  - `--watch` mode geliştirici friendly
- **Sürüm**: Vitest 1.x (en güncel stable)

### Test DB: **Testcontainers + real PostgreSQL 16**

- **Karşılaştırma**:
  - `sqlite-memory`: PostgreSQL-spesifik feature'lar (GiST exclusion, partial index, `$extends` semantik, `Prisma.JsonNull`, transaction isolation levels) **test edilmez**. Audit plugin için kullanılamaz.
  - `pg-mem`: bazı SQL dialect uyumsuzlukları, GIST yok, JSONB sınırlı.
  - **Testcontainers**: Real `postgres:16-alpine` container per-suite. ~3-5sn boot; `docker.sock` host'a mount.
- **Sürüm**: `testcontainers@^10` (Node binding)

### RabbitMQ: **bu PR'da YOK**

- İlk PR sadece DB-bound test'lere odaklanır.
- RabbitMQ + outbox testi sonraki PR (Madde 7 + 2 ile birlikte tasarlanır).
- Mock yok: RMQ test'leri eklendiğinde **gerçek `rabbitmq:3.12` container** kullanılır.

### Audit plugin için yan-koşul: **gerçek `$extends`**

Audit plugin BCMS'in en kritik invariant'ı; mock $extends behavior ≠ real. Testcontainers + real PG zorunlu.

---

## 3. İlk Kapsam — 3 Spec

İlk PR sadece bu üçünü kapsar. Her biri kendi bölümünde "neden kritik" + "ne test edilecek" netleştirilir.

### Spec 1 — `audit.plugin.spec.ts`

**Neden kritik**: BCMS proje kuralı: "All writes MUST go through the Prisma `$extends` audit plugin." Plugin bug = compliance kaybı. Mevcut bilinen riskler (audit raporundan):

- `findFirst` BEFORE-write pattern (single-row update/delete'te 2 round-trip)
- `MAX_BULK_AUDIT_ROWS=1000` cap (batch 2'de eklendi)
- `onSend` phantom-write protection (`statusCode < 400`)
- Worker context (ALS yok) → anında write fallback

**Kapsam**:

```
✓ Single-row create: audit_log row yazılır (action=CREATE)
✓ Single-row update: before snapshot + after payload, action=UPDATE
✓ Single-row delete: before snapshot, action=DELETE
✓ updateMany 5 row: 5 audit row, action=UPDATE
✓ updateMany >1000 row: ilk 1000 + warn log, bulk truncated kayıt
✓ HTTP request rollback (4xx response): pendingAuditLogs flush ETMEZ
✓ Worker context (no ALS): anında yazılır
✓ AuditLog modelin kendisi audit'e yazmaz (recursion guard)
✓ entityId fallback (composite-PK olmayan write): warn log + entityId=0
```

### Spec 2 — `schedule.service.spec.ts`

**Neden kritik**: Optimistic locking + conflict check + serializable retry, BCMS'in en sık çakışan iş akışı (concurrent edit). Bu tester'ın yokluğunda PR-1 (refactor schedule-list) güvenli değil.

**Kapsam**:

```
✓ create: GiST exclusion conflict → 409 + sanitizeConflicts (count + IDs + window, başlık/status sızmaz)
✓ create live-plan (channelId=null): GiST bypass; conflict check yok
✓ update with If-Match version match: ok, version increment
✓ update with If-Match stale version: 412
✓ update without If-Match: ok (fail-open senaryosu)
✓ update conflict on time change: 409
✓ Serializable retry: P2034 simülasyonu, 3 deneme
✓ remove: hard delete (FK cascade davranışı)
✓ usageScope filter: broadcast vs live-plan ayrışması
```

### Spec 3 — `booking.service.spec.ts`

**Neden kritik**: Status transition + group permission + merge-aware date check (commit `e66b4b5`'te düzelttik) — regresyon koruması.

**Kapsam**:

```
✓ create with scheduleId: schedule existence pre-check (404 if missing)
✓ create transactional: schedule silinirse FK violation 409
✓ update status PENDING → APPROVED: ok
✓ update status PENDING → invalid: 409 (transition rejected)
✓ update startDate-only when existing dueDate stale: 400 (merge-aware date check)
✓ update assignee without permission: 403 (canAssign false)
✓ removeForRequest cross-group: 403
✓ batch import (Excel buffer): N rows tek query'le validate; partial success
```

---

## 4. CI Entegrasyonu

### Job ayrımı

`.github/workflows/ci.yml`'de **ayrı job** `api-integration-tests`:

- `build-and-smoke` mevcut job: hızlı (lint + build + smoke). Default branch protection bu job'a bağlı kalır.
- `api-integration-tests` yeni job:
  - `services: postgres` (Testcontainers'ı bypass: CI'da nested docker yerine GH runner'ın PG service'i kullan).
  - `npm run test:integration -w apps/api`
  - **Branch protection'a eklenir** main merge için.

### Service Postgres vs Testcontainers

CI runner'da Docker-in-Docker var ama yavaş; daha hızlı pattern:
- **Lokal geliştirici**: Testcontainers (auto-spin)
- **CI**: GH Actions `services: postgres` (zaten boot edilmiş; suite başında `prisma migrate reset --force --skip-seed`)

`vitest.config.ts` ortam değişkeniyle ayrım:
```ts
const testDbUrl = process.env.TEST_DATABASE_URL  // CI'da set edilir
  || await testcontainers.spinPostgres();        // lokal fallback
```

### Coverage

Vitest `c8` provider ile coverage. Hedef:
- İlk PR: **%50 line coverage** sadece `audit.ts`, `schedule.service.ts`, `booking.service.ts` için.
- Genel hedef yok (zorla yüksek coverage anti-pattern; kritik path öncelik).

---

## 5. Test DB Lifecycle

### Strateji: **migrate reset per suite**

```
Suite başında:
  1. testcontainers postgres up (lokal) || env DATABASE_URL (CI)
  2. ⚠️  INTERIM: `npx prisma db push --skip-generate --accept-data-loss --force-reset`
     (hedef: `npx prisma migrate reset --force --skip-seed --skip-generate`)
  3. seed minimal fixtures (channels, leagues, broadcast types)

Test sonrası (afterEach):
  - cleanupTransactional(): TRUNCATE 15 transactional tablo; seed tablolar korunur
  - Per-test transaction rollback DEĞİL — Fastify-decorated app.prisma client'ı
    test wrapper transaction context'ine zorla bağlanamaz; "rollback oldu sandık
    ama olmadı" riski (audit $extends side-effect ile ayrıca kötüleşir)

Suite sonunda:
  - disconnectPrisma() (singleton pool drain)
  - Container teardown (lokal); CI'da no-op
```

> **⚠️ INTERIM — Migration baseline bağımlılığı (2026-05-04)**
>
> İlk implementation'da (`a45ee74`) `prisma migrate reset` yerine `db push --force-reset`
> kullanıldı. Sebep: BCMS migration directory'si yalnızca incremental migration'lar
> içeriyor; baseline tablolar (`schedules`, `bookings`, `leagues` vb.) ilk migration'da
> yok varsayılıyor — fresh DB'de `migrate reset` "schedules tablosu yok" hatası verir.
>
> Bu **bilinçli interim**. `db push` schema.prisma'dan direkt schema oluşturduğu
> için test scope'unda doğru çalışır; ancak migration yolculuğunu valide etmez
> (production deploy davranışından farklı).
>
> **Geri dönüş planı**: Audit doc skip listesi **Madde 1** (AuditLog partition + migration
> baseline yeniden temellendirme) PR'ı sonrası, `setup.ts` satırı tekrar
> `prisma migrate reset --force --skip-seed --skip-generate`'e çevrilir. O zaman
> test foundation production migration'larını da tüketmiş olur.
>
> Bkz: `ops/REQUIREMENTS-MIGRATION-BASELINE.md`

### Prisma client

Test'ler için **gerçek `PrismaClient` + audit extension** kullanılır. Mock client yok; mockın audit interceptor ile uyumsuz davranma riski büyük.

### Veri seed

`apps/api/prisma/test-seed.ts` (yeni dosya):
- 3 channel (HD/SD/RADIO örnekler)
- 2 league (Süper Lig, Premier Lig)
- 1 broadcast type (`MAÇ`)

Suite-spesifik seed (örn. `schedule.service.spec.ts` kendi test fixture'ları) test içinde inline yapılır.

---

## 6. Local Geliştirici Komutları

`apps/api/package.json` script eklemeleri:

```json
{
  "scripts": {
    "test:integration": "vitest run --config ./vitest.integration.config.ts",
    "test:integration:watch": "vitest --config ./vitest.integration.config.ts",
    "test:integration:coverage": "vitest run --config ./vitest.integration.config.ts --coverage"
  }
}
```

Lokal koşum:
```bash
# Docker daemon çalışıyor (testcontainers için):
docker ps

# Test çalıştır:
npm run test:integration -w apps/api

# Watch mode (TDD):
npm run test:integration:watch -w apps/api
```

CI dışı network gerek **yok** (testcontainers Docker daemon'a yerel erişir).

---

## 7. Acceptance Criteria

İlk PR'ın "merged" olabilmesi için:

- [ ] `apps/api/vitest.integration.config.ts` mevcut, `setup` dosyası test DB connect/migrate sağlıyor.
- [ ] `apps/api/prisma/test-seed.ts` minimal fixture seed sağlıyor.
- [ ] `apps/api/src/**/*.integration.spec.ts` 3 spec dosyası mevcut: `audit`, `schedule.service`, `booking.service`.
- [ ] Her spec en az **5 happy path + 3 error path** test içeriyor (toplam ≥24 test).
- [ ] `npm run test:integration -w apps/api` lokal'de **yeşil**.
- [ ] CI'da `api-integration-tests` job mevcut + main merge için zorunlu.
- [ ] CI runtime artışı **≤5 dakika** (mevcut `build-and-smoke` ile paralel çalışırsa toplam değişmez).
- [ ] Coverage report HTML output: `apps/api/coverage/index.html` (gitignored).
- [ ] README veya CONTRIBUTING güncellemesi: "Backend test çalıştırma" bölümü.

---

## 8. Sonraki İterasyonlar (Out-of-scope, ileride)

- **RabbitMQ integration tests**: outbox/DLQ tasarımı sonrası (Madde 7 + 2 PR).
- **Auth/RBAC tests**: requireGroup integration; mock JWT + real DB.
- **API route-level tests**: supertest ile HTTP layer (mevcut Playwright E2E ile örtüşme analizi).
- **Performance benchmarks**: schedule list 50K row, audit retention 1M row.
- **Coverage hedefi yükseltme**: %50 → %75 progressive.

---

## 9. Açık Karar Noktaları (PR öncesi netleştirilmeli)

| Karar | Seçenekler | Default önerim |
|---|---|---|
| Test container vs CI service postgres | (a) sadece testcontainers (b) sadece CI service (c) hybrid env-driven | (c) hybrid |
| Per-test isolation | (a) `prisma.$transaction` rollback (b) truncate strategy (c) migrate reset per-suite + transaction per-test | (c) |
| Coverage tool | (a) c8 (b) istanbul | (a) c8 |
| `setup` dosyası lokasyonu | (a) `apps/api/test/setup.ts` (b) `apps/api/src/test-utils/setup.ts` | (a) — src dışı |
| Spec naming | (a) `*.spec.ts` (b) `*.integration.spec.ts` (c) `*.test.ts` | (b) — unit test'lerden ayrılır |

PR öncesi bu kararlar **scope review**'da sabitlenir.

---

## 10. Risk + Bağımlılık

| Risk | Değerlendirme | Mitigation |
|---|---|---|
| Testcontainers Docker daemon gerektirir | Geliştirici Docker yoksa lokal koşamaz | CI service postgres ile fallback; CONTRIBUTING'de Docker zorunluluğu yazılır |
| CI runtime artışı >5dk | Test suite büyürse | Paralel job + suite splitting (audit/schedule/booking ayrı job'larda) |
| Prisma migrate reset slow (~5sn) | Suite başına bir kez | Acceptable; alternative: tek migrate + truncate per-test (karmaşık) |
| Audit plugin test'i flaky | onSend timing-bound | Vitest deterministic + explicit await pattern |

**Bağımlılık**: Bu PR herhangi bir mimari maddeyi (1, 3, 4, 7) bloke etmez ama **tetikleyici**: bu PR merge edilince, sonraki migration/refactor PR'ları test foundation'ı kullanabilir.

---

## Onay Akışı

Bu doc'un implement aşamasına geçmesi için:

1. Stack seçimi (§2): kullanıcı onayı.
2. İlk kapsam (§3): kullanıcı onayı (scope drift olmasın).
3. Açık karar noktaları (§9): kullanıcı seçimi.
4. PR açılır → review → merge.

Implement aşamasında ayrıntı kararlar (test fixture isimleri, helper helper API'leri) PR review'da netleşir.
