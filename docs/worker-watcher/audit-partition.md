# audit-partition

## Özet
`audit_logs` tablosunun **aylık partition'larını önceden oluşturan** job. Production'da audit_logs partition'lı
tablodur; bu job yaklaşan aylar için partition'ları hazır tutar (insert'ler partition eksikliğinden fail etmesin).

## Nerede çalışır
- **Container:** worker (`audit-partition`)
- Başlatma: `app.ts` → boot'ta bir kez `runOnce`, sonra `setInterval(24h)`
- Heartbeat: `audit-partition` (günlük; expected 24h, stale 25h)

## Ne iş yapıyor
- `monthsAhead(now, 4)` → mevcut + 3 ileri ay için partition oluşturur (`ensureMonthlyPartition`).
- **Idempotent:** `CREATE TABLE IF NOT EXISTS`.
- `isTablePartitioned` skip: dev/test'te regular tabloda no-op + warn (SQL fail önlenir).
- **Dry-run:** `AUDIT_PARTITION_DRY_RUN=true` (öncelik), `AUDIT_RETENTION_DRY_RUN=true` (backward-compat ikincil).

## Neye bağlı
- **DB:** `audit_logs` partition şeması (DDL).
- **Tetikleyici:** boot + 24 saatte bir.

## İlgili kod
`apps/api/src/modules/audit/audit-partition.job.ts`, `audit-partition.helpers.ts`
Runbook: `ops/RUNBOOK-AUDITLOG-PARTITION-DEPLOY.md`
