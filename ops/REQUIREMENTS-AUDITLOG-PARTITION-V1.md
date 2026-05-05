# AuditLog Partition V1 — Tasarım Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Audit doc skip listesi **Madde 1**.
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 1 + finding 3.1.2 (AuditLog partition yok).
> **Pattern**: `ops/REQUIREMENTS-BACKEND-INTEGRATION-TESTS.md` ile aynı design-first yapı.

## Amaç

`audit_logs` zaman-serisi append-only tablo; partition'sız büyüyor:
- 14 günde 571K satır (~40K/gün, audit doc verisi)
- 1 yıl ≈ 14M satır
- Index B-tree büyür (lookup yavaşlar; özellikle `[entityType, entityId]`)
- Retention purge (mevcut tek-DELETE) milyonlarca satırlık single-tx + büyük WAL üretimi

Çözüm: PostgreSQL declarative range partitioning (monthly), retention `DROP PARTITION` (instant, no row locks).

> **Out of scope (bu doc):**
> - TimescaleDB değerlendirmesi (red gerekçesi §3'te kalır)
> - AuditLog schema değişikliği (alan ekleme/silme — ayrı concern)
> - `AuditLogAction` enum genişletme (UPDATEMANY/DELETEMANY — ayrı küçük migration)
> - Migration baseline restoration **adjacent cleanup**, aynı PR'a zorunlu **değil** (§9)

---

## 1. Mevcut Durum (read-only verify)

### 1.1 Schema

```prisma
model AuditLog {
  id            Int            @id @default(autoincrement())
  entityType    String         @map("entity_type") @db.VarChar(50)
  entityId      Int            @map("entity_id")
  action        AuditLogAction
  beforePayload Json?          @map("before_payload")
  afterPayload  Json?          @map("after_payload")
  user          String         @db.VarChar(100)
  ipAddress     String?        @map("ip_address") @db.VarChar(45)
  timestamp     DateTime       @default(now()) @db.Timestamptz(6)
  deleted_at    DateTime?

  @@index([entityType, entityId])
  @@index([user])
  @@index([timestamp])
  @@map("audit_logs")
}
```

**Doğrulanan kritik özellikler:**
- Partition key adayı: **`timestamp` kolonu** (Prisma alanı `timestamp`, DB kolonu `timestamp` — `@map` yok). Type `Timestamptz(6)`. ✅ verify edildi (`grep` sonucu).
- PK `id` SERIAL — partitioning sonrası composite olmalı (`(id, timestamp)`). PG kuralı: partition key tüm PK/unique constraint'lerde olmak zorunda.
- FK **referenced değil** (no other table FK'ler audit_logs.id) — verify edildi (`grep` boş). Migration güvenli.
- `deleted_at` kolon mevcut ama hiç kullanılmıyor — audit log soft-delete pattern'i yok (retention hard delete). Bu doc'ta dokunulmuyor; ayrı temizlik kapsamı.

### 1.2 Mevcut retention job

`apps/api/src/modules/audit/audit-retention.job.ts`:
- Daily run; cutoff = Istanbul midnight - 90 gün.
- Tek `deleteMany({ timestamp: { lt: cutoff } })` (batch 1 fix sonrası, commit `0c7a8af`).
- 3 deneme + 10s/20s/40s exponential backoff (commit `0c7a8af`).
- **Gerçek davranış**: ilk run'da ~600K+ satır (1 yıl birikmişse milyonlar) tek transaction'da silinir → büyük lock window + WAL üretimi + replication lag riski.
- Audit plugin (`$extends`) burada bypass edilir mi? `auditLog.deleteMany` audit interceptor'a girmez (recursion guard `if (model === 'AuditLog') return query(args)` — verify edildi).

### 1.3 Volume verisi (audit raporundan)

- 571K satır / 14 gün = **~40,800/gün ortalama**
- Peak: ~80K/gün varsayımı (audit raporu yok ama defensive)
- 30 günlük partition büyüklüğü: ~1.2M satır × ~200 byte ≈ 250MB / partition (cap planning için)

---

## 2. Stack Seçimi

### 2.1 PG Declarative Range Partitioning (Monthly)

**Seçilen** çözüm: `PARTITION BY RANGE (timestamp)`, aylık sub-partitions.

**Karşılaştırma:**

| Seçenek | Pro | Con | Sonuç |
|---|---|---|---|
| **A. PG declarative monthly range partitioning** | Standart, FK kısıtlaması yok (audit_logs FK referenced değil), `DROP PARTITION` instant retention | PK composite olmalı; partition pre-create ops cron gerek | ✅ seçildi |
| B. TimescaleDB hypertable | Auto-partitioning, compression, time-series query opt | PG extension dependency, container image değişir, sadece audit_log için overkill | ❌ red |
| C. Status quo + chunked DELETE | Migration yok | Index bloat sürer, retention yine yavaş | ❌ red (problem çözmez) |

### 2.2 90-gün Retention vs Monthly Partition — Açık Karar (Guard 1)

> **Önemli nüans**: Monthly partition drop **coarse-grained** olur. 90 gün retention'ı tam garanti etmek için üç alternatif var:

| Strateji | Açıklama | Pro | Con |
|---|---|---|---|
| **a. Daily partitions** | Her gün ayrı sub-partition | Tam 90 gün retention; `DROP PARTITION` instant | 90+ partition aktif; pre-create cron daha sık; query planner overhead |
| **b. Monthly + son partition chunked DELETE** | Monthly drop + 90 gün boundary'sini aşan satırlar son partition içinde manuel DELETE | Partition sayısı az; retention ~90 gün net | Hybrid — drop'un sağladığı zero-lock benefit'i yarı kayıp |
| **c. Yaklaşık 90-120 gün kabul** | Aylık partition; ay sonunda drop = ~30 günlük tolerance | En basit; partition cron minimal | Retention "yaklaşık 90-120 gün"; uyumluluk/legal kontrol gerek |

**Karar**: implementation PR'ından önce kullanıcı tercih eder. Default önerim **(c)** — BCMS audit retention için tam-90-gün hassasiyeti business gereği değil (NIST/PCI-DSS gibi spesifik regülasyon yok). 30 gün toleransla retention "≥90 gün" garantisi yeterli. Ama eğer compliance argümanı çıkarsa (a) veya (b).

### 2.3 Default Partition — Trade-off (Guard 3)

Default partition (`PARTITION OF audit_logs DEFAULT`) **operational safety sağlar**:
- Pre-create cron unutulduğunda yeni timestamp insert'leri default'a düşer; insert fail-fast olmaz.
- **Trade-off**: default'a düşen veriler sessizce büyür; partition'lanmamış kalır → retention drop'tan etkilenmez, query planner partition pruning yapamaz.

**İki yaklaşım:**
- **A. Default partition var + monitoring**: insert default'a düştüğünde metric/alarm; ops cron failure görünür.
- **B. Default partition yok**: pre-create cron failure → insert fail (audit yazılamaz). Audit kayıp riski kabul edilemez.

**Karar**: implementation öncesi netleş. Default önerim **A** + monitoring zorunlu (`bcms_audit_default_partition_rows` Prometheus metric).

### 2.4 PK Composite Zorunluluğu

PG kuralı: partition key tüm PK/unique constraint'lerde bulunmak zorunda. Mevcut `id INT @id` tek-kolon PK; partitioning sonrası **`(id, timestamp)` composite PK** olmalı.

**Etki:**
- Application-level FK yok (verify edildi) → uygulama kırılmaz.
- Prisma `@id` directive composite kullanır:
  ```prisma
  @@id([id, timestamp])
  ```
- `id` SERIAL kalır; otomatik artan, ama lookup'larda `WHERE id = N` partition pruning yapamaz (partition key değil). **Audit lookup pattern'leri timestamp range'i içermeli** (zaten öyle — UI audit log filter'ı tarih aralığı ile çalışıyor).

---

## 3. Migration Adımları

### 3.1 Online vs Downtime — Açık Karar

| Yaklaşım | Pro | Con |
|---|---|---|
| Online (pg_partman, pg_repack benzeri tool) | Zero-downtime; production OK | Tool dependency, dikkat gerek |
| Downtime (kısa) | Basit; tek script | ~5-15 dk maintenance window |

BCMS internal tool (~10-50 kullanıcı, on-prem) → **kısa downtime kabul edilebilir**. Default önerim: maintenance window'da swap.

### 3.2 Adımlar (downtime variant)

1. **Yeni partitioned tablo create**:
   ```sql
   CREATE TABLE audit_logs_v2 (
     id            SERIAL,
     entity_type   VARCHAR(50) NOT NULL,
     entity_id     INTEGER NOT NULL,
     action        audit_log_action NOT NULL,
     before_payload JSONB,
     after_payload  JSONB,
     "user"        VARCHAR(100) NOT NULL,
     ip_address    VARCHAR(45),
     timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     deleted_at    TIMESTAMPTZ,
     PRIMARY KEY (id, timestamp)
   ) PARTITION BY RANGE (timestamp);
   ```

2. **Sub-partitions create** (geriye 12 ay + ileriye 3 ay + default):
   ```sql
   CREATE TABLE audit_logs_2025_06 PARTITION OF audit_logs_v2
     FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
   -- ... her ay ...
   CREATE TABLE audit_logs_default PARTITION OF audit_logs_v2 DEFAULT;
   ```

3. **Index'leri her partition'a uygula**:
   ```sql
   CREATE INDEX ON audit_logs_v2 (entity_type, entity_id);
   CREATE INDEX ON audit_logs_v2 ("user");
   CREATE INDEX ON audit_logs_v2 (timestamp);
   ```

4. **Data copy** (chunked, 100K batch):
   ```sql
   INSERT INTO audit_logs_v2 SELECT * FROM audit_logs;
   -- Veya chunked: WHERE timestamp BETWEEN ... LIMIT 100000
   ```

5. **Sequence sync**:
   ```sql
   SELECT setval(pg_get_serial_sequence('audit_logs_v2', 'id'),
                 (SELECT MAX(id) FROM audit_logs));
   ```

6. **Swap**:
   ```sql
   ALTER TABLE audit_logs RENAME TO audit_logs_legacy;
   ALTER TABLE audit_logs_v2 RENAME TO audit_logs;
   ```

7. **Prisma schema update**:
   ```prisma
   model AuditLog {
     id        Int      @default(autoincrement())
     timestamp DateTime @default(now()) @db.Timestamptz(6)
     ...
     @@id([id, timestamp])  // composite
     @@map("audit_logs")
   }
   ```

8. **Application restart** (Prisma client schema reload).

9. **`audit_logs_legacy`** rollback için 7-30 gün saklanır (açık karar §10).

### 3.3 Rollback Stratejisi

- `ALTER TABLE audit_logs RENAME TO audit_logs_v2_failed; ALTER TABLE audit_logs_legacy RENAME TO audit_logs;`
- Application restart.
- **Kritik**: rollback penceresi `audit_logs_legacy` tutulduğu sürece açık. Yeni audit yazımları rollback sonrası kayıp olur (yeni partitioned tablo'ya yazılmıştı). **Karar**: rollback'i ilk 24 saat içinde yapmak yeterli; sonrası audit kayıp tolere edilemez → "rollback safe" değil ileri saatlerde.

---

## 4. Audit Plugin (`$extends`) Etkisi

`apps/api/src/plugins/audit.ts` `$allOperations` interceptor:
- `if (model === 'AuditLog') return query(args)` — recursion guard. ✅ Partitioned table aynı `AuditLog` model adı; davranış değişmez.
- `auditLog.createMany` insert: PG distributed insert partition key'e göre routing yapar; uygulama farkı yok.
- `auditLog.findMany` (retention job): partition pruning otomatik (timestamp filter ile).

**Etki**: zero. Plugin'de değişiklik gerek yok. **Verify**: integration test (`audit.plugin.integration.spec.ts` — Madde 8 sonraki spec) partitioned table üzerinde çalışmalı.

---

## 5. Retention Job Değişikliği

**Mevcut**: `audit-retention.job.ts` daily `deleteMany({ timestamp: { lt: cutoff } })`.

**Yeni**: ay başında en eski partition `DROP TABLE`:

```ts
// Pseudo-code; SQL via $queryRaw
async function dropExpiredPartitions(retentionDays = 90) {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000);
  const expiredPartitions = await prisma.$queryRaw<{ partition_name: string }[]>`
    SELECT child.relname AS partition_name
    FROM pg_inherits
    JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
    JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
    WHERE parent.relname = 'audit_logs'
      AND child.relname ~ '^audit_logs_[0-9]{4}_[0-9]{2}$'
      AND -- partition end date < cutoff
      ...
  `;
  for (const { partition_name } of expiredPartitions) {
    await prisma.$executeRawUnsafe(`DROP TABLE "${partition_name}"`);
  }
}
```

**Davranış değişikliği:**
- Eski tek-DELETE: 600K row × 200 byte = 120MB transaction; lock 10-30 sn.
- Yeni `DROP TABLE`: instant (DDL); zero row lock; WAL minimal.

**Risk**: yanlış partition drop edilirse audit log kaybı. Mitigation: `WHERE` filter çift kontrol + `audit_logs_legacy` rollback penceresi.

---

## 6. Partition Pre-create Cron — Açık Karar

Aktif partition + 3 ay ileri pre-create gerek (boş partition'a insert fail eder; default partition var ama orada birikme istenmez).

**Seçenekler:**
- **A. App cron** (`audit-partition-job.ts` — yeni background service): aylık check, eksik partition'ları create et.
- **B. pg_cron extension** (PG eklentisi; Docker image değişir).
- **C. Manuel ops** (ops/scripts/bcms-audit-partition-rotate.sh): cron-job.d veya systemd timer.

Default önerim: **A** (app cron) — BCMS BackgroundService pattern'iyle uyumlu, ek altyapı yok.

---

## 7. db push Interim ile İlişki

Madde 8 test foundation `db push --force-reset` interim'i (commit `54de726`'da dokümante) migration baseline borcu yüzünden kullanılıyor. AuditLog partition migration'ı baseline'ı düzeltir mi?

**Beklenen etki**: Bu PR migration'lar dizinine yeni bir migration ekler. Mevcut baseline drift (eski tablolar baseline'da yok) bu PR ile **çözülmez** — sadece audit_logs partitioning'i ekler. Test foundation'ın `db push` interim'i sürer.

**Migration baseline restoration ayrı iş** (Guard 4):
- "Adjacent cleanup" — bu PR'ın bağımlılığı veya doğal sonuçu **değil**.
- Ayrı PR: `prisma migrate diff` ile mevcut DB schema'sını baseline migration olarak commit; sonra incremental migration'lar (audit partition dahil) üstüne uygulanır.
- Test foundation'ın `migrate reset`'e dönüşü baseline restoration sonrası olur.

**Bu doc'ta dokunulan kısım**: Madde 1 partition migration'ı kendi başına self-contained olmalı; baseline restoration **§9 risk maddesinde** referans olarak kalır.

---

## 8. Risk + Bağımlılık

| Risk | Değerlendirme | Mitigation |
|---|---|---|
| Migration downtime (data copy) | ~5-15 dk; 14M satır 100K batch'lerle ~10 dk | Maintenance window planla; chunked INSERT |
| Rollback penceresi audit kaybı | Yeni audit'ler partitioned tabloya; rollback eski tabloya geri dönerse arada yazılan audit kaybolur | Rollback ilk 24 saat içinde; sonrası "rollback safe değil" |
| Default partition sessiz büyüme | Pre-create cron failure tespit edilmezse default'a birikir | Prometheus metric + alarm (`bcms_audit_default_partition_rows`) |
| Composite PK uygulama etkisi | `id` SERIAL'den lookup `WHERE id = N` partition pruning yapamaz | Audit lookup'lar zaten timestamp range filter'ı kullanıyor; pratikte etki yok |
| Replication lag (eğer replica varsa) | Data copy 100K batch'ler ile büyük WAL | Replica `streaming_lag_seconds` izle; gerekirse async replica geçici disable |
| Migration baseline drift birleşik confusion | Bu PR baseline'ı düzeltmez; net olmazsa karışır | §7 açıkça "adjacent cleanup, not a dependency" işaretliyor |

**Bağımlılık zinciri:**
- AuditLog partition → Madde 8 audit plugin spec (partitioned table üzerinde davranış doğrulaması).
- Migration baseline restoration → Madde 8 test foundation `migrate reset` dönüşü.
- DLQ (Madde 2) + Outbox (Madde 7) → audit_logs ile ilgili değil, paralel.

---

## 9. Açık Karar Noktaları (PR öncesi netleşmeli)

| # | Karar | Seçenekler | Default önerim |
|---|---|---|---|
| 1 | Retention granularity | (a) daily partition (b) monthly + chunked DELETE (c) ~90-120 gün kabul | (c) — BCMS regülasyon yok |
| 2 | Default partition | (a) var + monitoring (b) yok, fail-fast | (a) + Prometheus metric |
| 3 | Online vs downtime migration | (a) pg_partman/pg_repack tool (b) downtime maintenance window | (b) — BCMS internal scale |
| 4 | `audit_logs_legacy` saklama süresi | (a) 7 gün (b) 30 gün (c) 90 gün | (b) — rollback + post-migration audit |
| 5 | Partition pre-create cron yeri | (a) app cron (b) pg_cron extension (c) ops script | (a) — pattern uyumlu |
| 6 | Partition adlandırma | (a) `audit_logs_YYYY_MM` (b) `audit_logs_pYYYYMM` | (a) — read-friendly |
| 7 | Migration baseline restoration aynı PR'da mı? | (a) evet (b) ayrı PR | (b) — blast radius (Guard 4) |

PR öncesi bu kararlar **scope review**'da sabitlenir.

---

## 10. Acceptance Criteria

PR'ın merge'i için:

- [ ] Migration dosyası mevcut: `2026XXXX_audit_log_partition_v1/migration.sql`.
- [ ] Migration lokal'de yeşil: `audit_logs` partitioned, sub-partitions create, data copy doğru, sequence senkronize.
- [ ] Prisma schema update: `@@id([id, timestamp])` composite PK.
- [ ] Retention job refactor: `audit-retention.job.ts` `DROP PARTITION` pattern'ine geç.
- [ ] Partition pre-create cron eklendi (`audit-partition-job.ts` — app cron BackgroundService).
- [ ] Prometheus metric: `bcms_audit_default_partition_rows` (default partition gözlem).
- [ ] Integration test: yeni `audit-retention.integration.spec.ts` — partition drop davranışı.
- [ ] Integration test: mevcut `audit.plugin.integration.spec.ts` (Madde 8 sonraki) yeşil — `$extends` partitioned table üzerinde uyumlu.
- [ ] `apps/api lint` + `apps/web build` yeşil.
- [ ] Rollback runbook: `ops/RUNBOOK-AUDITLOG-PARTITION-ROLLBACK.md` (yeni dosya).
- [ ] CI billing çözüldükten sonra CI yeşil (CI-validated, mevcut blocked durum dışı).

---

## 11. Sonraki İterasyonlar (Out-of-scope, ileride)

- **AuditLog schema değişikliği** (örn. `request_id` correlation id): ayrı migration.
- **Partition compression** (PG 17+): partition seviyesinde sıkıştırma — eski partition'lar için disk tasarrufu.
- **Cross-partition query optimization**: `pg_stat_statements` izle; gerekirse `EXPLAIN ANALYZE`-based index tuning.
- **Migration baseline restoration** (Madde 1 sonrası ayrı PR): test foundation'ın `migrate reset`'e dönüşü.

---

## 12. Onay Akışı

Bu doc'un implement aşamasına geçmesi için:

1. Açık karar noktaları (§9): kullanıcı seçimi (özellikle retention granularity + default partition + legacy saklama).
2. Acceptance criteria (§10): kullanıcı onayı.
3. Implementation PR açılır → review → maintenance window planla → merge + deploy.

Implementation sırasında ayrıntı kararlar (sub-partition naming convention son hali, cron exact schedule, vb.) PR review'da netleşir.
