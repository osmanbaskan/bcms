# AuditLog Partition Rollback Runbook

**Migration:** `20260505000002_audit_log_partition_v1`
**Tasarım**: `ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md`
**Versiyon**: 1.0 (2026-05-05)

Bu runbook PR-1A migration'ını **production'a deploy ettikten sonra** rollback gerekirse uygulanır. Lokal/dev'de rollback dry-read için yeterli.

> **Kritik kural**: Rollback **ilk 24 saat içinde** güvenlidir. Bu pencerede yeni partitioned tabloya yazılan audit log'lar `audit_logs_legacy`'e geri taşınmaz → audit kayıp olur. **Kullanıcı + ops imza vermeden rollback yapılmaz**.

---

## 0. Pre-rollback Çek-Listesi

- [ ] Migration deploy üzerinden **24 saat geçmedi** (geçtiyse rollback safe değil; data loss risk).
- [ ] Sorun gerçekten partition migration'dan kaynaklı (semptomları logla; başka olası sebepler elendi).
- [ ] Production audit log yazımı **şu an durduruldu** veya minimal (rollback sırasında yazımlar kayboluyor).
- [ ] `audit_logs_legacy` tablosu hâlâ mevcut (PR-1E henüz çalıştırılmadıysa OK).
- [ ] Maintenance window (~5-10 dk) duyuruldu.
- [ ] Backup alındı: `pg_dump -t audit_logs -t audit_logs_legacy bcms > /tmp/audit_pre_rollback.sql`.
- [ ] Operatör + sahibinin imzası alındı.

---

## 1. Database Rollback (DDL)

```sql
BEGIN;

-- 1.1. Partitioned tabloyu rename et (legacy ismi).
ALTER TABLE  "audit_logs"                    RENAME TO "audit_logs_partitioned_failed";
ALTER INDEX  "audit_logs_entity_type_entity_id_idx" RENAME TO "audit_logs_partitioned_failed_entity_type_entity_id_idx";
ALTER INDEX  "audit_logs_user_idx"           RENAME TO "audit_logs_partitioned_failed_user_idx";
ALTER INDEX  "audit_logs_timestamp_idx"      RENAME TO "audit_logs_partitioned_failed_timestamp_idx";
ALTER INDEX  "audit_logs_deleted_at_idx"     RENAME TO "audit_logs_partitioned_failed_deleted_at_idx";
ALTER SEQUENCE "audit_logs_id_seq"           RENAME TO "audit_logs_partitioned_failed_id_seq";

-- 1.2. Legacy tabloyu geri production ismine al.
ALTER TABLE  "audit_logs_legacy"                          RENAME TO "audit_logs";
ALTER INDEX  "audit_logs_legacy_entity_type_entity_id_idx" RENAME TO "audit_logs_entity_type_entity_id_idx";
ALTER INDEX  "audit_logs_legacy_user_idx"                 RENAME TO "audit_logs_user_idx";
ALTER INDEX  "audit_logs_legacy_timestamp_idx"            RENAME TO "audit_logs_timestamp_idx";
ALTER INDEX  "audit_logs_legacy_deleted_at_idx"           RENAME TO "audit_logs_deleted_at_idx";
ALTER SEQUENCE "audit_logs_legacy_id_seq"                 RENAME TO "audit_logs_id_seq";

-- 1.3. Legacy sequence migration sırasında setval ile sync edilmemişti — yeniden senkronize et:
SELECT setval(
    'audit_logs_id_seq',
    GREATEST(COALESCE((SELECT MAX("id") FROM "audit_logs"), 0), 1),
    true
);

COMMIT;
```

---

## 2. Application Rollback (Prisma schema)

```diff
 model AuditLog {
-  id            Int            @default(autoincrement())
+  id            Int            @id @default(autoincrement())
   entityType    String         @map("entity_type") @db.VarChar(50)
   ...
   deleted_at    DateTime?

-  @@id([id, timestamp])
   @@index([entityType, entityId])
   @@index([user])
   @@index([timestamp])
   @@map("audit_logs")
 }
```

Composite PK → single PK geri dönüşü. **Etkisi**: Prisma `findUnique({ id })` selector tekrar `{ id }` (composite değil). Pre-flight verify (2026-05-05): kodda `findUnique({ id })` zaten yok; rollback Prisma client kullanıcı koduna görünür değişiklik yaratmaz.

```bash
# Prisma client yeniden generate et + deploy
cd apps/api
npx prisma generate
docker compose up -d --build api worker
```

---

## 3. Sanity Doğrulama (Rollback Sonrası)

```sql
-- Tablo audit_logs single PK, eski yapı:
SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'audit_logs' ORDER BY ordinal_position;

-- Insert default sequence çalışıyor:
INSERT INTO audit_logs (entity_type, entity_id, action, "user")
  VALUES ('ROLLBACK_VERIFY', 1, 'CREATE', 'rollback_test')
  RETURNING id, timestamp;

DELETE FROM audit_logs WHERE "user" = 'rollback_test';

-- Partitioned failed tablo hâlâ duruyor (manuel cleanup 7 gün sonra):
SELECT relname FROM pg_class WHERE relname LIKE 'audit_logs_partitioned_failed%';
```

---

## 4. Post-rollback

- [ ] Application restart edilen container'lar healthy → `/health` endpoint OK.
- [ ] Yeni audit log yazımı işliyor: trigger bir endpoint (örn. POST schedule), `SELECT MAX(id), MAX(timestamp) FROM audit_logs` kontrol et.
- [ ] Retention job çalışıyor (next 24h cycle): log'larda "Audit retention purge complete" görünmeli.
- [ ] **Geçici tablo cleanup (manuel, 7 gün sonra)**:
  ```sql
  -- audit_logs_partitioned_failed bir hafta sonra:
  DROP TABLE audit_logs_partitioned_failed CASCADE;
  ```
- [ ] Post-mortem: `ops/post-mortems/<date>-audit-partition-rollback.md` (sebep, etki, sonraki retry planı).

---

## 5. Rollback Sonrası Tekrar Deneme

Migration başarısız olduysa:
1. Sebebi tespit et (log'lar, hata mesajı, replication lag, vb.).
2. `ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md`'i güncelle (yeni karar varsa).
3. PR-1A retry: bu kez problemi adresleyen değişiklikle.

> **Not**: Migration baseline restoration (audit doc skip listesi adjacent cleanup) henüz yapılmamış. Tekrar deneme öncesinde baseline çözülmüşse retry daha güvenli olur.

---

## 6. Yardım

- DBA / SystemEng: ilk müdahale.
- Audit owner: data loss riskinin kabul edilebilir olduğunu onaylama.
- Kullanıcı sahibi (osmanbaskan): final imza.
