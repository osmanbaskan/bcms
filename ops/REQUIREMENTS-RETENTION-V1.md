# Data Retention V1 — Tasarım Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi).
> **Audit referansı**: 2026-05-29 250-user 10-yıl kapasite analizi — DB 80GB → 500GB disiplinsiz büyüme riski.
> **Pattern**: `ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md` ile aynı design-first yapı.

## Amaç

BCMS DB tablolarında **kontrolsüz büyüme** prod 250 user × 10 yıl senaryosunda DB'yi 400-600 GB'a çıkarır, query latency 1-3 saniyeye fırlatır, autovacuum lock contention yaratır.

Çözüm: tablo bazlı retention politikası + cold storage dump'ı + planlı temizlik.

**Politika özet** (kullanıcı kararı, 2026-05-29):
- **Log/audit veri**: **6 ay** (180 gün) içerde aktif, üstü cold storage'a → DELETE
- **Operasyonel DB veri**: **2 yıl** (730 gün) içerde, üstü cold storage'a → DELETE
- **DEAD/DLQ outbox**: **1 yıl** (365 gün) — forensic için uzun
- Cold storage: **lokal** `/home/ubuntu/Desktop/bcms/backups/archive/`
- Dump format: **SQL gzip** (`pg_dump --format=custom | gzip`)
- REINDEX: lokal'de YOK, **prod runbook** olarak ayrı

> **Out of scope (bu doc):**
> - REINDEX implementation (prod runbook ayrı: `ops/RUNBOOK-REINDEX-V1.md` placeholder)
> - Cold storage external (S3/Glacier) — V2 scope
> - Replication / HA (V2+ scope)
> - audit_logs_legacy temizleme (tek seferlik manuel adım, §10.6)
> - node-exporter / cAdvisor monitoring (ayrı PR: monitoring expansion)
> - Schedule retention cross-domain coupling (live-plan satellite cascade detayı §6.5)

---

## 1. Mevcut Durum (read-only verify)

### 1.1 Tablo boyutları (2026-05-29 16:00 ölçüm, test mode 1-2 user)

| Tablo | Satır | Disk total | Retention |
|---|---|---|---|
| `audit_logs_2026_04` | 565.032 | 104 MB | 90 gün (partition drop) |
| `audit_logs_legacy` | 571.104 | 102 MB | YOK (tek seferlik temizlik) |
| `provys_items` | 46.507 | 34 MB | YOK |
| `asrun_items` | 52.043 | 28 MB | YOK |
| `matches` | 108.482 | 21 MB | YOK |
| `audit_logs_2026_05` | 30.652 | 18 MB | 90 gün (partition drop) |
| `studio_plan_slots` | 236 | 248 kB | YOK |
| `ssdb_material_cache` | 416 | 224 kB | TTL ile invalidate |
| `outbox_events` | 157 | 152 kB | YOK |
| `live_plan_entries` | 88 | 120 kB | YOK |
| `schedules` | 1 | 112 kB | YOK |

**DB toplam**: 319 MB.

### 1.2 Günlük büyüme (test mode)

| Tablo | Periyot | Günlük |
|---|---|---|
| `audit_logs` | 39 gün, 595.684 satır | ~15.700/gün |
| `provys_items` | 7 gün, 46.507 satır | ~6.640/gün |
| `asrun_items` | 5 gün, 52.043 satır | ~10.400/gün |
| `matches` | 40 gün, 108.482 satır | ~2.700/gün |
| `outbox_events` | 21 gün, 155 satır | ~7/gün (test idle) |

### 1.3 250 user prod projeksiyon (10 yıl)

| Veri | Çarpan | Günlük prod | 10 yıl row | Disk (retention'sız) |
|---|---|---|---|---|
| audit_logs | ×30 | 470K | 1.7 milyar | 280 GB |
| outbox_events | ×100+ | 25K | 91M | 30 GB |
| provys_items | ×1 | 6.6K | 24M | 14 GB |
| asrun_items | ×1 | 10.4K | 38M | 14 GB |
| matches | ×1 | 2.7K | 9.8M | 2 GB |

### 1.4 Mevcut retention infrastructure

- `apps/api/src/modules/audit/audit-retention.job.ts` — daily worker, partition drop, 90 gün default
- `AUDIT_RETENTION_DAYS` env (mevcut)
- `audit_logs` zaten partitioned (`PARTITION BY RANGE (timestamp)`)
- Diğer tablolarda retention worker **YOK**

---

## 2. Politika Tablosu (canonical)

| Tablo | Kategori | Retention | Cold storage | Frequency | Notu |
|---|---|---|---|---|---|
| `audit_logs` | Log | **180 gün** | Evet | Daily | Partition drop + dump |
| `audit_logs_legacy` | Tek seferlik | 0 (manuel temizlik) | Evet | One-shot | §10.6 |
| `outbox_events` (status=PUBLISHED) | Log | **180 gün** | Hayır¹ | Daily | DELETE only (idempotent event) |
| `outbox_events` (status=DEAD/DLQ) | Log | **365 gün** | Evet | Weekly | Forensic için dump |
| `provys_items` | Operasyonel | **730 gün** (schedule_date) | Evet | Weekly | Yıl bazlı dump |
| `asrun_items` | Operasyonel | **730 gün** (schedule_date) | Evet | Weekly | Yıl bazlı dump |
| `matches` | Operasyonel | **730 gün** (created_at) | Evet | Weekly | OPTA forensic |
| `schedules` (broadcast) | Operasyonel | **730 gün** (schedule_date) | Evet | Weekly | |
| `live_plan_entries` | Operasyonel | **730 gün** (broadcastDate) | Evet | Weekly | Satellite tabloları cascade (§6.5) |
| `search_jobs` | Log | **180 gün** (created_at) | Hayır | Daily | Terminal status zorunlu (SELECTED/NOT_FOUND/CANCELLED/FAILED) |
| `restore_jobs` | Log | **180 gün** (created_at) | Hayır | Daily | Terminal status zorunlu (DONE/FAILED/CANCELLED) |
| `transfer_jobs` | Log | **180 gün** (created_at) | Hayır | Daily | Terminal status zorunlu (DONE/FAILED/CANCELLED) |
| `ssdb_material_cache` | Cache | Süresiz | Hayır | — | TTL ile auto-invalidate |
| `studio_plan_slots` | Operasyonel | **730 gün** | Evet | Weekly | Düşük volume |
| `bookings` | Operasyonel | **730 gün** | Evet | Weekly | Düşük volume |
| Lookup tabloları (`*_options`) | Reference | Süresiz | — | — | Az satır, dokunma |

¹ PUBLISHED outbox event idempotent: yeniden yayın sorunu yok, cold storage gereksiz.

---

## 3. Stack Seçimi

### 3.1 Partition drop vs DELETE

| Tablo | Yöntem | Sebep |
|---|---|---|
| `audit_logs` | **Partition drop** | Zaten partitioned (monthly); instant, lock yok |
| Diğer hepsi | **Batched DELETE** | Partition'a değer değil (haftalık volume düşük) |

Batched DELETE pattern:
```ts
const CHUNK = 5_000;
let total = 0;
while (true) {
  const r = await prisma.$executeRaw`
    DELETE FROM <tablo>
    WHERE id IN (
      SELECT id FROM <tablo>
      WHERE <date_col> < ${cutoff}
      LIMIT ${CHUNK}
    )
  `;
  total += r;
  if (r < CHUNK) break;
  await sleep(100); // autovacuum'a nefes
}
```

### 3.2 Dump format: pg_dump custom + gzip

```bash
docker compose exec -T postgres pg_dump \
  -U bcms_user -d bcms \
  --format=custom \
  --data-only \
  --table=<schema>.<tablo> \
  --where="<date_col> < '<cutoff>'" \
  | gzip > backups/archive/<category>/<year>/<tablo>_<period>.sql.gz
```

**Alternatif**: `--format=plain` (SQL text) — küçük tablolarda daha okunabilir ama büyük volume'da slow.

`--format=custom` seçildi:
- `pg_restore` ile parallel restore
- Index'siz dump (zaten restore'da yeniden oluşur)
- Size: custom %30 daha küçük plain'e göre

### 3.3 Audit log için partition pre-drop dump

Partition drop instant ama veri kaybı geri alınamaz. **Pre-drop dump zorunlu**:
```ts
async function archivePartition(partitionName: string, year: number, month: number) {
  const archivePath = `${COLD_STORAGE_BASE}/audit/${year}/${partitionName}.sql.gz`;
  await ensureDir(path.dirname(archivePath));

  // 1. pg_dump partition
  await runCmd(`docker compose exec -T postgres pg_dump \
    -U bcms_user -d bcms --format=custom --data-only \
    --table=public.${partitionName} | gzip > ${archivePath}`);

  // 2. Verify dump readable
  const verified = await verifyDumpReadable(archivePath);
  if (!verified) throw new RetentionError(`Dump verify failed: ${archivePath}`);

  // 3. Compare row count
  const dumpRows = await pgRestoreRowCount(archivePath);
  const dbRows = await prisma.$queryRaw`SELECT count(*) FROM ${partitionName}`;
  if (dumpRows !== dbRows) throw new RetentionError(`Row mismatch: dump=${dumpRows} db=${dbRows}`);

  // 4. Safe to drop
  await prisma.$executeRaw`ALTER TABLE audit_logs DETACH PARTITION ${partitionName}`;
  await prisma.$executeRaw`DROP TABLE ${partitionName}`;
}
```

---

## 4. Cold Storage Yapısı

### 4.1 Dizin layout

```
backups/
├── archive/                              # P-RET-V1 scope
│   ├── audit/                            # 5+ yıl saklama (forensic)
│   │   ├── 2026/
│   │   │   ├── audit_logs_2026_01.sql.gz
│   │   │   ├── audit_logs_2026_02.sql.gz
│   │   │   └── ...
│   │   └── 2027/
│   ├── outbox/                           # 5 yıl saklama
│   │   ├── 2026/
│   │   │   └── outbox_dead_2026.sql.gz   # sadece DEAD/DLQ
│   ├── operational/                      # 5 yıl saklama
│   │   ├── 2026/
│   │   │   ├── provys_items_2026.sql.gz
│   │   │   ├── asrun_items_2026.sql.gz
│   │   │   ├── matches_2026.sql.gz
│   │   │   ├── schedules_2026.sql.gz
│   │   │   ├── live_plan_2026.sql.gz
│   │   │   ├── studio_plan_slots_2026.sql.gz
│   │   │   └── bookings_2026.sql.gz
│   │   └── 2027/
│   └── _manifest/                        # operasyon kayıt
│       └── 2026-05-29-archive.json       # dump'lar + hash + counts
├── snapshots/                            # Mevcut: full DB snapshots
│   └── bcms-full-YYYYMMDD.sql.gz
└── .archive-config.json                  # retention config snapshot
```

### 4.2 Lokasyon (kullanıcı kararı 2026-05-29)

- **Lokal**: `/home/ubuntu/Desktop/bcms/backups/archive/`
- Disk yer kontrolü: pre-flight `df` check (free space ≥ dump tahmin ×2)
- Compression: gzip default level 6

### 4.3 Manifest dosyası (audit trail)

Her retention run'ı `_manifest/<date>-archive.json` yazar:
```json
{
  "runId": "ret_2026_05_29_03_00_audit",
  "executedAt": "2026-05-29T03:00:00+03:00",
  "policy": "audit-180d",
  "table": "audit_logs",
  "cutoffDate": "2025-11-29",
  "archives": [
    {
      "path": "audit/2025/audit_logs_2025_11.sql.gz",
      "rowCount": 487231,
      "sizeBytes": 52341234,
      "sha256": "abc123...",
      "partitionDropped": true
    }
  ],
  "deletedRowsTotal": 487231,
  "durationMs": 12340,
  "status": "success"
}
```

---

## 5. Modül Yapısı (yeni)

```
apps/api/src/modules/retention/
├── retention.config.ts                  # ENV → policy table
├── retention.cold-storage.ts            # pg_dump wrapper + verify
├── retention.audit-helpers.ts           # Prisma audit ext entegrasyonu
├── retention.metrics.ts                 # Prometheus counters
├── retention.errors.ts                  # Custom errors (RetentionError, DiskFullError, ...)
├── audit-retention.job.ts               # ⚠️ mevcut, refactor (180g + dump)
├── outbox-retention.job.ts              # YENİ — 180g PUBLISHED + 365g DEAD
├── provys-retention.job.ts              # YENİ — 730g
├── asrun-retention.job.ts               # YENİ — 730g
├── opta-retention.job.ts                # YENİ — matches 730g
├── schedule-retention.job.ts            # YENİ — 730g
├── live-plan-retention.job.ts           # YENİ — 730g + satellite cascade
└── jobs-retention.job.ts                # YENİ — search/restore/transfer 180g
```

Her job export edilen pure fn:
```ts
export interface RetentionRunResult {
  archivedRowsTotal: number;
  deletedRowsTotal: number;
  archivePaths: string[];
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  errorMsg?: string;
}

export async function runProvysRetention(deps: RetentionDeps): Promise<RetentionRunResult>;
```

---

## 6. Per-Tablo SQL + Logic

### 6.1 audit_logs (180 gün + partition drop)

```sql
-- Hedef partition'ları bul
SELECT relname FROM pg_inherits
  JOIN pg_class child ON inhrelid = child.oid
  JOIN pg_class parent ON inhparent = parent.oid
  WHERE parent.relname = 'audit_logs'
    AND child.relname ~ '^audit_logs_\d{4}_\d{2}$';

-- Her partition için: parse YYYY_MM → tarih, cutoff_date (today - 180gün) ile karşılaştır
-- Eski olanlar için:
--   1. pg_dump --table=audit_logs_2025_11 → cold storage
--   2. ALTER TABLE audit_logs DETACH PARTITION audit_logs_2025_11;
--   3. DROP TABLE audit_logs_2025_11;
```

Idempotent: aynı run iki kez çalışırsa skip (dump zaten var → verify ile geç).

### 6.2 outbox_events (180g PUBLISHED + 365g DEAD)

```sql
-- 1. PUBLISHED cleanup (dump YOK)
DELETE FROM outbox_events
WHERE status = 'PUBLISHED'
  AND published_at < now() - INTERVAL '180 days';
-- Chunk: 5000

-- 2. DEAD/DLQ dump + delete (haftalık)
-- Dump:
COPY (SELECT * FROM outbox_events WHERE status IN ('DEAD','DLQ') AND created_at < now() - INTERVAL '365 days')
  TO PROGRAM 'gzip > backups/archive/outbox/2026/outbox_dead_2026.sql.gz';
-- Delete:
DELETE FROM outbox_events
WHERE status IN ('DEAD','DLQ')
  AND created_at < now() - INTERVAL '365 days';
```

### 6.3 provys_items (730 gün, schedule_date bazlı)

```sql
-- Yıl bazlı dump (kümülatif: 2023 yılı dump'lanır 2026'da)
-- Cutoff: today - 730 gün
SELECT min(schedule_date), max(schedule_date) FROM provys_items
  WHERE schedule_date < (current_date - INTERVAL '730 days');

-- pg_dump --table=provys_items \
--   --where="schedule_date >= '2023-01-01' AND schedule_date < '2024-01-01'" \
--   → operational/2023/provys_items_2023.sql.gz

-- DELETE chunked
DELETE FROM provys_items
WHERE schedule_date < (current_date - INTERVAL '730 days');
```

### 6.4 asrun_items + matches + schedules + studio_plan_slots + bookings

Aynı pattern: yıl bazlı dump, chunked DELETE, audit ext.

### 6.5 live_plan_entries (cascade satellite tabloları)

`live_plan_entries` silinmeden ÖNCE bağımlı tablolar:
- `live_plan_technical_details` (1:1)
- `live_plan_transmission_segments` (1:N)

Sıra:
```ts
const cutoff = subDays(today(), 730);
// 1. Hedef ID'leri çek
const expiredIds = await prisma.livePlanEntry.findMany({
  where: { broadcastDate: { lt: cutoff } },
  select: { id: true },
});
const ids = expiredIds.map(r => r.id);

// 2. Dump live_plan_entries + technical_details + segments (3 tablo)
await dumpTables(['live_plan_entries', 'live_plan_technical_details', 'live_plan_transmission_segments'],
  `WHERE entry_id IN (${ids.join(',')})`);

// 3. Cascade DELETE (FK ON DELETE CASCADE varsa tek delete; yoksa sıralı)
await prisma.$transaction([
  prisma.livePlanTransmissionSegment.deleteMany({ where: { entryId: { in: ids } } }),
  prisma.livePlanTechnicalDetail.deleteMany({ where: { entryId: { in: ids } } }),
  prisma.livePlanEntry.deleteMany({ where: { id: { in: ids } } }),
]);
```

### 6.6 search_jobs / restore_jobs / transfer_jobs (180g, terminal only)

```sql
-- Terminal status zorunlu (aktif job silinmesin)
DELETE FROM search_jobs
WHERE status IN ('SELECTED','NOT_FOUND','FAILED','CANCELLED')
  AND created_at < now() - INTERVAL '180 days';

DELETE FROM restore_jobs
WHERE status IN ('DONE','FAILED','CANCELLED')
  AND created_at < now() - INTERVAL '180 days';

DELETE FROM transfer_jobs
WHERE status IN ('DONE','FAILED','CANCELLED')
  AND created_at < now() - INTERVAL '180 days';
```

---

## 7. Schedule + Worker Integration

### 7.1 Background services

`apps/api/src/app.ts` `BACKGROUND_SERVICES` listesine eklenir:
```ts
const BACKGROUND_SERVICES = [
  // ... mevcut ...
  'audit-retention',         // mevcut, refactor edilir
  'outbox-retention',        // YENİ
  'provys-retention',        // YENİ
  'asrun-retention',         // YENİ
  'opta-retention',          // YENİ
  'schedule-retention',      // YENİ
  'live-plan-retention',     // YENİ
  'jobs-retention',          // YENİ
];
```

`docker-compose.yml` worker env'inde `BCMS_BACKGROUND_SERVICES` virgülle eklenir.

### 7.2 Tick schedule

| Job | Schedule | Hour (Istanbul) | Notu |
|---|---|---|---|
| audit-retention | Daily | 03:00 | Partition drop hızlı |
| outbox-retention (PUBLISHED) | Daily | 03:15 | Hızlı DELETE |
| outbox-retention (DEAD) | Weekly Sun | 04:00 | Dump + delete |
| jobs-retention | Daily | 03:30 | Düşük volume |
| provys-retention | Weekly Sun | 04:30 | Yıl bazlı dump |
| asrun-retention | Weekly Sun | 05:00 | Yıl bazlı dump |
| opta-retention | Weekly Sun | 05:30 | Yıl bazlı dump |
| schedule-retention | Weekly Sun | 06:00 | Yıl bazlı dump |
| live-plan-retention | Weekly Sun | 06:30 | Cascade dump |

**Trigger**: cron-like check; her tick'te:
```ts
function shouldRun(now: Date, schedule: { type: 'daily'|'weekly', hour: number, day?: number }): boolean {
  const ist = toIstanbul(now);
  if (ist.hour !== schedule.hour) return false;
  if (schedule.type === 'weekly' && ist.dayOfWeek !== schedule.day) return false;
  return true;
}
```

İdempotency: manifest dosyasına aynı `runId` yazılırsa skip.

---

## 8. Error Handling + Dry-Run

### 8.1 Dry-run modu

`RETENTION_DRY_RUN=true` env → tüm worker'lar DUMP yapar, DELETE **etmez**:
- Pre-flight disk check
- Hedef row count log
- Dump'a yazar (verify check)
- Manifest'e `"status": "dry-run"` yazar
- DELETE SKIP

Önerilen ilk 2 hafta dry-run mode (production deploy sonrası).

### 8.2 Pre-flight checks

Her job başında:
1. **Disk free space**: `df -B1 /backups` ≥ tahmin dump ×2 (güvenlik marjı)
2. **DB lock**: aktif uzun transaction yoksa (autovacuum/REINDEX/migration) — bekle veya skip
3. **Manifest var mı**: aynı `runId` daha önce yazılmış → skip (idempotent)
4. **Audit ext aktif**: assert audit plugin enabled (CLAUDE.md hard rule)

### 8.3 Failure paths

| Hata | Davranış |
|---|---|
| Disk dolu | Job abort + alert (Prometheus counter) + manifest "failed" |
| pg_dump exit code !=0 | Retry 3× (5s/10s/20s) → terminal failed |
| Dump verify fail | Dump dosyası sil + retry; 3 başarısız → manuel inceleme alert |
| DELETE chunk fail | Restart from last committed offset (tx ile) |
| Audit ext bypass tespit | Process abort (assertion fail) |

### 8.4 Transactional safety

Dump → Delete sıralaması **atomic değil**. Pratik koruma:
1. Dump SUCCESS + verify ZORUNLU before DELETE
2. DELETE chunked (5000 row × tx) → kısmi başarı OK
3. Manifest yazılır son: DELETE tamamlanmadan manifest yok → restart aynı run'ı kaldığı yerden alır

---

## 9. Metrics + Observability

`apps/api/src/plugins/metrics.ts` yeni counter'lar:

```ts
export const retentionRunsTotal = new Counter({
  name: 'bcms_retention_runs_total',
  help: 'Retention job run count by table + result',
  labelNames: ['table', 'result'] as const, // result: success|partial|failed|dry-run
});

export const retentionArchivedRowsTotal = new Counter({
  name: 'bcms_retention_archived_rows_total',
  help: 'Rows dumped to cold storage by table',
  labelNames: ['table'] as const,
});

export const retentionDeletedRowsTotal = new Counter({
  name: 'bcms_retention_deleted_rows_total',
  help: 'Rows deleted from live DB by table',
  labelNames: ['table'] as const,
});

export const retentionDurationSeconds = new Histogram({
  name: 'bcms_retention_duration_seconds',
  help: 'Retention job run duration',
  labelNames: ['table'] as const,
  buckets: [1, 5, 15, 60, 300, 900, 3600],
});

export const retentionDiskFreeBytes = new Gauge({
  name: 'bcms_retention_disk_free_bytes',
  help: 'Cold storage path free space',
});
```

Alert rule (`infra/prometheus/alerts.yml`):
```yaml
- alert: RetentionJobFailing
  expr: increase(bcms_retention_runs_total{result="failed"}[24h]) > 0
  for: 5m
  labels: { severity: high }
  annotations:
    summary: "Retention job failed: {{ $labels.table }}"

- alert: ColdStorageDiskLow
  expr: bcms_retention_disk_free_bytes < 50 * 1024 * 1024 * 1024  # 50 GB
  for: 10m
  labels: { severity: high }
```

---

## 10. Implementation Adımları (Faz-Bazlı)

### Faz 1: Foundation (modül + helper + dry-run)

**1.1** `retention.config.ts` — env → policy table
**1.2** `retention.cold-storage.ts` — pg_dump wrapper + verify + manifest
**1.3** `retention.metrics.ts` — Prometheus counters
**1.4** `retention.errors.ts` — RetentionError, DiskFullError
**1.5** Env değişkenleri `.env.example` + `docker-compose.yml` worker
**1.6** Pre-flight check helper (disk, lock, manifest, audit ext)

**Verify**: dry-run mode mevcut audit_logs için (DELETE etmez, dump'ı al + manifest)

### Faz 2: audit_logs refactor (180g + dump)

**2.1** `audit-retention.job.ts` — `AUDIT_RETENTION_DAYS` 90→180 default
**2.2** Partition drop ÖNCE dump çağrısı eklenir
**2.3** Manifest entegrasyonu
**2.4** Mevcut testler güncellenir (`audit-retention.job.unit.spec.ts`)

**Verify**: lokal dev'de 180+ gün partition yoksa dry-run pass; aksi halde dump dosyası oluşur, partition drop edilir.

### Faz 3: outbox_events retention (en basit — dump yok PUBLISHED için)

**3.1** `outbox-retention.job.ts` — daily PUBLISHED cleanup
**3.2** Weekly DEAD/DLQ dump + delete
**3.3** Worker bootstrap eklenir
**3.4** Unit spec

**Verify**: test outbox row üret → 181 gün eski timestamp set → job çalıştır → DELETE doğrula.

### Faz 4: Operasyonel tablolar — provys/asrun/matches

**4.1** `provys-retention.job.ts` — 730g + dump (yıl bazlı)
**4.2** `asrun-retention.job.ts` — aynı pattern
**4.3** `opta-retention.job.ts` (matches) — aynı pattern
**4.4** Worker bootstrap
**4.5** Unit specs

**Verify**: test row 731 gün eski → dump'a yazar → DELETE doğrular.

### Faz 5: schedule + live_plan (cascade)

**5.1** `schedule-retention.job.ts` — 730g broadcast row (event_key IS NOT NULL)
**5.2** `live-plan-retention.job.ts` — 730g + satellite cascade
**5.3** Unit specs (cascade order)

### Faz 6: jobs (search/restore/transfer)

**6.1** `jobs-retention.job.ts` — 180g terminal status only
**6.2** Worker bootstrap
**6.3** Unit spec

### Faz 7: Production rollout

**7.1** Dry-run mode 2 hafta (sadece dump, DELETE etmez)
**7.2** Manifest review
**7.3** Live mode geçiş
**7.4** Alert rule activate
**7.5** Backup rotation runbook (`ops/RUNBOOK-COLD-STORAGE-ROTATION.md`)

### 10.6 audit_logs_legacy tek seferlik temizleme (Faz 7 sonrası)

102 MB eski format tablo:
```bash
# 1. Dump
docker compose exec -T postgres pg_dump -U bcms_user -d bcms \
  --table=audit_logs_legacy --format=custom \
  | gzip > backups/archive/audit/legacy/audit_logs_legacy_archive.sql.gz

# 2. Verify
docker compose exec -T postgres pg_restore -l \
  /backups/archive/audit/legacy/audit_logs_legacy_archive.sql.gz | head

# 3. Drop
docker compose exec -T postgres psql -U bcms_user -d bcms \
  -c "DROP TABLE audit_logs_legacy;"
```

---

## 11. Verification

### 11.1 Unit tests

Her job için spec:
- `retention.cold-storage.unit.spec.ts` — dump path generation + manifest
- `retention.config.unit.spec.ts` — env parsing + clamp
- Per-job `*-retention.job.unit.spec.ts` — dry-run + cutoff + chunked DELETE

### 11.2 Integration tests

`*.integration.spec.ts` (Testcontainer):
- Audit partition drop full cycle
- Outbox cleanup with mixed status
- Provys retention with realistic 100K row dataset
- live_plan cascade satellite cleanup

### 11.3 Manual smoke (lokal dev)

```bash
# Dry-run tüm jobs
RETENTION_DRY_RUN=true docker compose up -d worker
# 1 saat bekle (cron tetiklenir)
# Manifest dosyalarını incele:
ls -la backups/archive/_manifest/

# Live mode tek tablo
RETENTION_DRY_RUN=false AUDIT_RETENTION_DAYS=180 docker compose up -d worker
# Audit partition drop log'unu izle
docker compose logs -f worker | grep retention
```

### 11.4 Disk usage validation

```bash
# DB boyut delta
docker compose exec -T postgres psql -U bcms_user -d bcms -c \
  "SELECT pg_size_pretty(pg_database_size('bcms'));"

# Cold storage boyut
du -sh backups/archive/
```

---

## 12. Risk + Rollback

### 12.1 Risk matrisi

| Risk | İhtimal | Etki | Karşı önlem |
|---|---|---|---|
| Yanlış DELETE (data loss) | Orta | Yüksek | Dry-run 2 hafta + manifest verify |
| Dump verify fail → delete olur | Düşük | Yüksek | Atomic: verify ZORUNLU before DELETE |
| Disk dolu → backup başarısız | Orta | Orta | Pre-flight df check |
| Audit ext bypass | Düşük | Yüksek | Assertion + smoke test |
| autovacuum lock contention | Orta | Düşük | Chunked DELETE + sleep arası |
| Cascade order yanlış (live_plan) | Düşük | Orta | Integration test + tx |
| Backup klasörü yedeklenmemiş | Orta | Yüksek | Backup-of-backup policy (V2 scope) |

### 12.2 Rollback (Faz-bazlı)

| Faz | Rollback |
|---|---|
| 1 | Worker'da yeni service'leri disable et (env'den çıkar) |
| 2 | `AUDIT_RETENTION_DAYS=90` geri (eski davranış); partition drop edilmişse dump'tan restore |
| 3-6 | Worker service disable; veri kaybı yoksa yeniden enable |
| Veri kaybı durumu | `pg_restore backups/archive/.../tablename_YYYY.sql.gz` |

### 12.3 Cold storage corruption riski

Lokal disk fail durumu: backup-of-backup yok. **V2 scope**: external sync (rsync to NAS, S3, vb.).

V1 mitigation:
- Manifest dosyasında SHA256 hash → corruption tespiti
- Yıllık manuel integrity check (`pg_restore -l` her arşiv için)

---

## 13. Sınır Notları (Out of Scope V1)

- **External cold storage** (S3 Glacier, NAS) → V2 PR
- **Replication / streaming backup** → V2 PR
- **Point-in-time recovery (PITR)** → ayrı concern
- **REINDEX otomasyon** → prod runbook (`ops/RUNBOOK-REINDEX-V1.md` placeholder)
- **node-exporter / cAdvisor** monitoring genişlemesi → ayrı PR
- **Restore mechanism** (cold storage'tan geri yükleme) → V2 PR + UI
- **Backup encryption at rest** → V2 PR (compliance)
- **Backup compliance** (KVKK/GDPR retention) → V2 (hukuk ekibi onayı)
- **Multi-tenant retention** (per-channel/per-customer) → V3 (kapsam dışı)

---

## 14. Beklenen Etki (10 yıl projeksiyon)

| Metrik | Disiplinsiz | **V1 ile** |
|---|---|---|
| DB boyut | 400-600 GB | **80-100 GB sabit** |
| audit_logs DB | 280 GB | **14 GB** (180 gün × 470K) |
| outbox_events DB | 30 GB | **9 GB** |
| provys+asrun DB | 28 GB | **6 GB** (2 yıl) |
| Cold storage | 0 (kayıp) | **~150-200 GB** (5 yıl) |
| Query P99 | 1-3 sn | **200-300 ms** |
| Tablo lock | sürekli | **planlı pencere** |
| Forensic erişim | kayıp | **dump'tan restore** |

---

## 15. Decision Lock + Sign-off

Bu doc'taki politika tablosu (§2) **LOCKED** kabul edilir; değişiklik için yeni V2 doc gerek.

Implementation Faz 1-7 sırası **sequential**: her faz pass etmeden bir sonraki başlamaz.

**Sign-off**: kullanıcı 2026-05-29 onayı sonrası implement başlar.
