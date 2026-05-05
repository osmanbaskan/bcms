# Data Model Correctness V1 — Tasarım Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Kapsam: audit raporu skip listesi **Madde 3** (`optaMatchId` kolon promote) + **Madde 4** (`usageScope` constraint).
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 3 + 4.
> **Pattern**: `ops/REQUIREMENTS-BACKEND-INTEGRATION-TESTS.md` ile aynı design-first yapı.

## Amaç

İki data-model temizliği:
- **Madde 3 (open)**: `schedules.metadata.optaMatchId` JSON path filter pattern'inden type-safe kolon + index'e geçiş.
- **Madde 4 (kısmen kapalı, doğrulanmalı)**: `usageScope` DB-level constraint — audit varsaymıştı yok, gerçekte var (migration `20260422000002`); kalan iş test + doc + opsiyonel enum migration.

İkisi de **migration baseline borcunu artırmadan** yapılabilir (kolon ekleme + CHECK incremental).

> **Out of scope (bu doc):** Madde 5 live-plan ayrı tablo (Madde 3 sonrası ayrı PR), Madde 1 AuditLog partition, Outbox/DLQ.

---

## 1. Mevcut Durum — Read-only Verify

### 1.1 Madde 3 — `metadata.optaMatchId`

**Schema:**
```prisma
model Schedule {
  ...
  metadata   Json?
  matchId    Int?    @map("match_id")
  match      Match?  @relation(fields: [matchId], references: [id])
  ...
}
model Match {
  ...
  optaUid    String?  @unique @map("opta_uid") @db.VarChar(50)
}
```

`schedules.match_id Int? FK to matches.id` **zaten var**. `Match.optaUid` zaten unique. Yani teknik olarak `Schedule → Match.optaUid` JOIN ile erişilebilir.

**Kullanım yerleri (`grep`):**

| Dosya | Satır | Pattern |
|---|---|---|
| `apps/api/src/modules/opta/opta.routes.ts` | 105 | `where: { metadata: { path: ['optaMatchId'], not: JsonNull } }` |
| `apps/api/src/modules/opta/opta.routes.ts` | 109 | `s.metadata.optaMatchId` extract for "to-schedule" filter |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | 290 | `metadata: { path: ['optaMatchId'], equals: u.matchUid }` |
| `apps/web/src/app/features/schedules/schedule-form/schedule-form.component.ts` | 455 | yazma: `{ optaMatchId: ..., source: 'opta' }` metadata içine |
| `apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts` | 1071 | yazma: `optaMatchId: m.matchId` metadata içine |

**Audit verisi (2026-05-04 inspection):** 132/132 schedule `metadata->>'optaMatchId'` dolu, JSON path full-scan.

### 1.2 Madde 4 — `usageScope`

**Schema:**
```prisma
model Schedule {
  usageScope  String  @default("broadcast") @map("usage_scope") @db.VarChar(30)
  @@index([usageScope])
}
```

**DB constraint** (mevcut migration `20260422000002_schedule_usage_scope_constraint`):
```sql
ALTER TABLE "schedules"
ADD CONSTRAINT "schedules_usage_scope_check"
CHECK ("usage_scope" IN ('broadcast', 'live-plan'));
```

**Audit raporundaki yanlış**: "CHECK constraint yok" iddiası `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` finding 3.1.4'te. **Constraint var; iddia hatalı**. Bu doc ile düzeltilir.

**Application enum**: `schedule.schema.ts` `ScheduleUsageScopeEnum = z.enum(['broadcast', 'live-plan'])`. Zod runtime validation + DB CHECK = double layer. ✅

**Kalan açık iş (Madde 4)**:
- Integration test: DB-level CHECK enforcement (raw SQL ile invalid değer reddediliyor mu)
- Schema-level documentation: `schema.prisma`'da CHECK olduğunun yorumla görünür kılınması (Prisma 5 native CHECK desteklemiyor)
- (defer) PG enum migration

---

## 2. Madde 3 — `optaMatchId` Kolon Promote

### 2.1 Hedef Schema Değişikliği

```prisma
model Schedule {
  ...
  optaMatchId  String?  @map("opta_match_id") @db.VarChar(50)
  ...
  @@index([optaMatchId])
}
```

> **Karar (2026-05-05, PR-3A onay):** `@unique` **kullanılmayacak**. Aynı OPTA match için
> birden fazla schedule entry mümkün:
> - Aynı maç farklı kanallarda yayın (örn. beIN Sports 1 + 4K).
> - Live-plan + broadcast aynı match için iki ayrı entry.
> - Re-play / archived broadcast.
>
> Non-unique B-tree index lookup performansı için yeterli; uniqueness invariant
> uygulama katmanında zorlamak isteniyorsa partial unique (örn.
> `WHERE channel_id IS NOT NULL AND status != 'CANCELLED'`) daha sonra
> ele alınabilir.

### 2.2 Migration Adımları

**PR sırası:**

1. **Migration A** — kolon ekleme + backfill (nullable):
   ```sql
   -- 2026XXXX_schedule_opta_match_id_promote/migration.sql
   ALTER TABLE "schedules" ADD COLUMN "opta_match_id" VARCHAR(50);
   CREATE UNIQUE INDEX "schedules_opta_match_id_unique" ON "schedules"("opta_match_id");

   -- Backfill from metadata
   UPDATE "schedules"
   SET "opta_match_id" = metadata->>'optaMatchId'
   WHERE metadata ? 'optaMatchId'
     AND metadata->>'optaMatchId' IS NOT NULL;
   ```
   Audit raporu 132 satır gösteriyor; backfill ~1 sn.

2. **PR-A code** — write path'leri kolon dolduracak (metadata da yazmaya devam, transition):
   - `schedule.service.create()`: dto'dan optaMatchId varsa kolona yaz; metadata.optaMatchId da yazılır (geri uyumluluk).
   - Frontend (`schedule-form`, `schedule-list`): yazma her iki yere.

3. **PR-A read path migrate** — opta lookup'ları kolon kullansın:
   - `opta.routes.ts:105`: `where: { optaMatchId: { not: null } }` (metadata path yerine).
   - `opta.routes.ts:109`: `s.optaMatchId` (metadata extract yerine).
   - `opta.sync.routes.ts:290`: `where: { optaMatchId: u.matchUid }`.
   Test: read-after-write tutarlılığı + index kullanım (EXPLAIN ANALYZE).

4. **PR-B (sonraki, ayrı)** — metadata yazımı kaldır + kolon NOT NULL:
   - Tüm caller'lar kolona geçtikten sonra metadata.optaMatchId yazımı kaldırılır.
   - Migration: `metadata = metadata - 'optaMatchId'` (key drop).
   - `ALTER TABLE schedules ALTER COLUMN opta_match_id SET NOT NULL` (eğer 100% dolu ise; live-plan'lar için NOT NULL olamaz, kontrol).

### 2.3 Rollback Stratejisi (PR-A)

- Migration roll-back: `DROP INDEX schedules_opta_match_id_unique; ALTER TABLE schedules DROP COLUMN opta_match_id;`
- Code rollback: revert PR; metadata yazımı zaten devam ediyor (transition window).
- Risk: backfill anında concurrent write için `optaMatchId` metadata'da değişirse drift; mitigation: migration single-transaction + lock `IN ACCESS EXCLUSIVE MODE` 132 satır için anlık.

### 2.4 Match FK Bağımlılığı

`Schedule.matchId` zaten var ama `optaMatchId` yazımıyla eşit doldurulmuyor olabilir. Bu PR'da **ele alınmıyor** — ayrı PR (Madde 5 ya da PR-B kapsamında) `match_id`'yi `optaMatchId → Match.optaUid` JOIN ile backfill eder.

---

## 3. Madde 4 — `usageScope` Doğrulama + Test

### 3.1 Mevcut CHECK Constraint Doğrulama (test)

Yeni integration test: `schedule.service.integration.spec.ts`'e (mevcut spec, `e579c46`) ek case veya ayrı `db-constraints.integration.spec.ts`:

```ts
test('DB CHECK: usageScope sadece broadcast | live-plan kabul eder', async () => {
  const prisma = getRawPrisma();
  await expect(
    prisma.$executeRawUnsafe(
      `INSERT INTO schedules (channel_id, start_time, end_time, title, usage_scope, created_by) ` +
      `VALUES (1, NOW(), NOW() + INTERVAL '1 hour', 'X', 'invalid_scope', 'test')`,
    ),
  ).rejects.toThrow(/check.*usage_scope|usage_scope.*check/i);
});
```

Bu test `cleanupTransactional()` öncesi/sonrası schemanın yenilendiğinde failure'ı garanti eder.

### 3.2 Schema.prisma Dokümantasyonu

```prisma
model Schedule {
  /// DB seviyesinde CHECK constraint: usage_scope IN ('broadcast', 'live-plan').
  /// Migration: 20260422000002_schedule_usage_scope_constraint.
  /// Yeni değer eklemek için: önce ALTER TABLE migration, sonra bu yorumu güncelle.
  usageScope  String  @default("broadcast") @map("usage_scope") @db.VarChar(30)
}
```

Prisma 5 inline CHECK desteklemiyor — yorum drift uyarısı görevi yapar.

### 3.3 PG Enum Migration (defer, out-of-scope bu PR)

Audit raporundaki "Öneri: A (PG enum)" yerine kullanıcı kararı: **CHECK constraint yeterli**, enum migration baseline hassasiyeti nedeniyle ertelenir. Gelecekteki ayrı PR'da değerlendirilir.

---

## 4. Risk + Bağımlılık

| Risk | Değerlendirme | Mitigation |
|---|---|---|
| Backfill concurrent write drift | 132 satır, migration anlık | Single-tx migration; ACCESS EXCLUSIVE lock kabul edilebilir |
| Frontend metadata + kolon dual-write geçici tutarsızlık | Transition window'da kolon ile metadata aynı kullanıcı yazımında saplanmaz | Service katmanı tek source of truth (kolon yazılır + metadata yazılır aynı tx) |
| Index size artışı | UNIQUE varchar(50) ~50KB / 1K row | Marjinal; izlenecek |
| Madde 5 (live-plan ayrı tablo) ile çakışma | optaMatchId kolon promote sonrası live-plan kararı daha temiz | İlk önce Madde 3, sonra Madde 5 (audit doc sıralaması ile uyumlu) |
| CHECK constraint test'in `migrate reset` interim'i ile çakışması | `db push --force-reset` migration history'yi tüketmez; ama CHECK schema'da değil migration'da | Test setup `db push` sonrası ek `$executeRawUnsafe` ile constraint apply (workaround); ya da Madde 1 sonrası migrate reset'e dönüş bunu otomatik çözer |

**Bağımlılık zinciri:**
- Madde 3 PR-A → Madde 5 (live-plan ayrı tablo)
- Madde 4 test → Madde 1 (migrate reset interim'i çözüldükten sonra constraint test daha temiz)

---

## 5. Açık Karar Noktaları (PR öncesi netleştirilmeli)

| Karar | Seçenekler | Default önerim |
|---|---|---|
| optaMatchId NOT NULL hedefi | (a) hep NOT NULL; live-plan için kolon dolu olmalı (b) NULL'a izin (c) live-plan'lar için ayrı tablo (Madde 5) | (b) bu PR; (c) Madde 5 ile birleşik tasarım |
| Backfill stratejisi | (a) tek-tx UPDATE + lock (b) chunked UPDATE (c) view + materialized | (a) — 132 satır |
| Frontend dual-write süresi | (a) sınırsız (b) bir release sonra metadata yazımı kaldır | (b) PR-B kapsamı |
| Madde 4 test'in test suite'e eklenmesi | (a) `schedule.service.integration.spec.ts`'e case ekle (b) ayrı `db-constraints.integration.spec.ts` | (b) — DB-level constraint'ler ayrı concern |
| `db push` interim'iyle CHECK test'i | (a) test setup'ında `$executeRawUnsafe` ile manual apply (b) Madde 1 sonrasına ertele | (a) interim için pragmatic |
| metadata.optaMatchId fallback read | (a) PR-A okumayı kolona çevir, metadata fallback (b) PR-A sadece kolon, metadata fallback yok | (a) defansif geçiş |

---

## 6. Acceptance Criteria

PR-A'nın merge'i için (Madde 3):

- [ ] `schedules.opta_match_id` kolonu + UNIQUE index migration mevcut.
- [ ] Backfill SQL migration'a dahil; lokal db push sonrası kolon dolu.
- [ ] `schedule.service.create/update` kolona yazıyor (metadata da yazmaya devam — transition).
- [ ] `opta.routes` ve `opta.sync.routes` lookup'ları kolon-based; metadata fallback opsiyonel.
- [ ] Frontend `schedule-form` + `schedule-list` kolona yazıyor.
- [ ] Integration test: `optaMatchId` ile schedule lookup happy path; UNIQUE constraint (aynı optaMatchId iki schedule = 409).
- [ ] `apps/api lint` + `apps/web build` yeşil.
- [ ] Migration rollback test edildi (lokal manuel).

Madde 4 için bu PR kapsamında:

- [ ] DB CHECK constraint integration test'i mevcut + yeşil.
- [ ] `schema.prisma` `Schedule.usageScope` üstüne /// yorum bloku eklendi.
- [ ] Audit doc düzeltmesi: finding 3.1.4 "CHECK constraint yok" iddiası "CHECK var, doğrulandı" olarak güncelle.

---

## 7. Sıralama Önerisi

| Sıra | İş | Bağımlılık |
|---|---|---|
| 1 | **PR-3A**: optaMatchId kolon + backfill + read/write geçişi | Bu doc onayı |
| 2 | **PR-4**: usageScope CHECK test + schema.prisma yorum + audit doc düzeltme | PR-3A merge sonrası (paralel olabilir) |
| 3 | **PR-3B** (defer): metadata yazımı kaldır + NOT NULL (eğer karar (a)) | PR-3A'nın stable çalışması, transition window kapanması |

---

## 8. Onay Akışı

Bu doc'un implement aşamasına geçmesi için:

1. Açık karar noktaları (§5): kullanıcı seçimi (özellikle NOT NULL hedefi + dual-write süresi).
2. Acceptance criteria (§6): kullanıcı onayı.
3. Sıralama (§7): kullanıcı onayı.
4. PR-3A açılır → review → merge.
5. PR-4 paralel başlatılabilir (CHECK test).

Implement sırasında ayrıntı kararlar PR review'da netleşir.
