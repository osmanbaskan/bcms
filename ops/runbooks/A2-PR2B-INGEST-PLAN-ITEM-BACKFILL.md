# A2 PR-2b — IngestJob.planItemId backfill runbook

**Durum:** TASLAK — bu PR ile eklendi.
**Bu PR'da production'da ÇALIŞTIRILMAZ.** Komut listesi referans amaçlıdır;
gerçek çalıştırma PR-2c (metadata fallback removal) öncesi ayrı onay turunda
yapılır.

---

## 1. Amaç

A2 PR-2a (`20260509000001_add_ingest_job_plan_item_fk`) production'a deploy
edildikten sonra, `ingest_jobs` tablosunda eski (legacy) satırlar şu durumda olabilir:

- `plan_item_id IS NULL`
- `metadata->>'ingestPlanSourceKey' IS NOT NULL`
- ve `ingest_plan_items.source_key = metadata->>'ingestPlanSourceKey'` ile eşleşen bir plan item var.

Bu satırların `plan_item_id` alanı boş kalır çünkü PR-2a yalnız ŞEMAYI ekledi
(ADD COLUMN + INDEX + FK ON DELETE SET NULL); UPDATE'i (DML) içermez
(DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §10/4 — "ADD COLUMN + UPDATE + DROP
aynı PR'da değil").

Backfill, bu eski satırları canonical FK'ye doldurur. A4 metadata kolon DROP'u
güvenli hâle getirir.

## 2. Önkoşullar

| # | Madde | Doğrulama |
|---|-------|-----------|
| 1 | A2 PR-2a production'da deploy edilmiş | `prisma migrate status` migration `20260509000001_add_ingest_job_plan_item_fk` uygulanmış |
| 2 | API + worker container'lar restart edilmiş | new schema known to runtime |
| 3 | **Yeni API image deploy edilmiş; container içinde `/app/dist/scripts/backfill-ingest-plan-item-id.js` mevcut** | `docker exec bcms_api ls /app/dist/scripts/backfill-ingest-plan-item-id.js` 0 dönmeli (PR-2b kod değişikliklerini içeren image build'inden sonra) |
| 4 | Production DB backup (snapshot) alınmış | DB ops onay |
| 5 | Bu runbook'un altında imza/onay zinciri tamamlanmış (bkz §7) | yazılı onay |
| 6 | Maintenance window açılmış (kritik canlı yayın yok) | canlı yayın takvimi check |

> **Not — execution path:** Production API container'ında yalnız `/app/dist/` ve
> `/app/node_modules/` mevcut; `apps/api/package.json`, `src/` ve `tsx` (devDep)
> image'da YOK. Bu yüzden `npm run backfill:...` komutu prod'da ÇALIŞMAZ.
> Aşağıdaki komutlar doğrudan `node dist/scripts/...` formunu kullanır
> (`/app/node_modules` üzerinden module resolution doğrulandı).

## 3. Komut: DRY-RUN (default — yazma yok)

Production api container içinde (doğrulanmış path):

```bash
docker exec -i bcms_api node dist/scripts/backfill-ingest-plan-item-id.js
```

Çıktı şu sayıları gösterir:

```
===== BACKFILL RAPORU =====
mod                : DRY-RUN
batch size         : 100
taranan (NULL FK)  : <N>
zaten dolu (FK)    : <M>
metadata key yok   : <a>
eşleşen (matchable): <b>
orphan (no planItem): <c>
update edilen      : 0
--- match örnekleri (ilk 10) ---
  jobId=... sourceKey=... → planItemId=...
--- orphan örnekleri (ilk 10) ---
  jobId=... sourceKey=... (planItem bulunamadı)
DRY-RUN: hiçbir kayıt güncellenmedi. Gerçek backfill için --execute ekleyin.
```

### Output nasıl okunur

| Alan | Anlam |
|------|-------|
| `taranan (NULL FK)` | `plan_item_id IS NULL` toplam satır sayısı |
| `zaten dolu (FK)`   | `plan_item_id IS NOT NULL` satır sayısı (kontrol) |
| `metadata key yok`  | scan altında ama `metadata.ingestPlanSourceKey` string değil — backfill kapsamı dışı |
| `eşleşen (matchable)` | scan altında ve hem key hem de planItem bulunan — execute modunda update edilecek |
| `orphan`            | key var ama `ingest_plan_items.source_key` ile eşleşen yok — update edilmez, raporlanır |
| `update edilen`     | execute modunda gerçekten yapılan UPDATE sayısı (dry-run'da daima 0) |

`matchable + orphan + noKey === scanned` invariant'ı sağlanmalı.

### Dry-run sonrası karar matrisi

- **`matchable === 0` ve `orphan === 0`** → backfill gerek yok; PR-2c
  doğrudan açılabilir.
- **`matchable > 0` ve `orphan === 0`** → execute edilebilir.
- **`orphan > 0`** → orphan satırların kaynağı incelenmeli (silinmiş plan
  item, manuel girilmiş key, vb.). Ya plan item geri yüklenir ya da bu
  job satırları operasyonel olarak NULL FK ile kalmaya bırakılır (job kaydı
  silinmez — DECISION V1 §2/6 historic preservation).

## 4. Komut: EXECUTE

DRY-RUN raporu onaylandıktan sonra:

```bash
docker exec -i bcms_api node dist/scripts/backfill-ingest-plan-item-id.js --execute
```

Opsiyonel batch size override (default 100):

```bash
docker exec -i bcms_api node dist/scripts/backfill-ingest-plan-item-id.js --execute --batch-size=200
```

### Çalışma profili

- Cursor-based scan, sadece `plan_item_id IS NULL` satırlar.
- Her satır için tek `update` (Prisma client → audit `$extends` plugin worker
  branch → `audit_logs` tablosuna `IngestJob` × `UPDATE` satırı).
- Idempotent: where klozunda `plan_item_id IS NULL` filter; race / duplicate
  run senaryosunda no-op.

### Audit telafisi

Audit plugin worker branch (HTTP context yok) audit girişlerini ANINDA
`audit_logs` tablosuna yazar. Backfill sonrası doğrulama:

```sql
SELECT COUNT(*) FROM audit_logs
 WHERE entity_type = 'IngestJob' AND action = 'UPDATE'
   AND created_at > '<execute başlangıç ts>';
```

Beklenen: `>= updated count`.

## 5. Idempotency + paralel run

İkinci execute çalıştırması:
- Scan zaten doldurulmuş satırları yeniden taramaz (cursor `plan_item_id IS NULL`).
- Kalan match olmaz; raporda `matchable=0`, `updated=0`.
- Hata sinyali değildir.

Birden fazla operatörün eş zamanlı çalıştırması güvenli (her update where
klozu `plan_item_id IS NULL` filter'lı; ikincisinin updateMany count=0).

## 6. Rollback yaklaşımı

Backfill **destructive değildir**: yalnız NULL kolonu doldurur. Geri alma
gerektiren senaryo:

| Senaryo | Aksiyon |
|---------|---------|
| Yanlış plan item'a bağlandığı tespit edildi | Etkilenen `(job_id, planItemId)` listesi snapshot'tan çıkarılır; `UPDATE ingest_jobs SET plan_item_id = NULL WHERE id IN (...)` (manuel onay; ops-runbook ayrı yazılır) |
| Tüm backfill geri alınmak isteniyor | `UPDATE ingest_jobs SET plan_item_id = NULL WHERE id IN (audit_logs.entity_id WHERE action='UPDATE' AND created_at > <ts>)` |

Not: Geri alma SQL **manuel onay + DBA gözetimi** ister; bu runbook kapsamı
dışında. Tercih edilen: backfill öncesi DB snapshot/backup'tan restore.

## 7. Production onay checklist (imza zinciri)

Aşağıdaki maddeler **gerçek execute öncesi** tek tek imzalanır:

- [ ] A2 PR-2a production'a deploy edilmiş + smoke OK (api + worker)
- [ ] DB snapshot/backup alınmış (timestamp: `__________`)
- [ ] Maintenance window açık (canlı yayın takvimi check)
- [ ] DRY-RUN çıktısı log'lanmış (path: `__________`)
- [ ] `matchable + orphan + noKey === scanned` invariant doğrulandı
- [ ] Orphan listesi gözden geçirildi; aksiyon: ☐ ignore ☐ plan item restore ☐ manuel investigate
- [ ] Operatör (kim): `__________`
- [ ] Onaylayan (kim): `__________`
- [ ] Execute timestamp: `__________`
- [ ] Execute sonrası rapor log'u: `__________`
- [ ] `audit_logs` IngestJob UPDATE sayımı doğrulandı (`>= updated`)

## 8. Fallback removal (PR-2c) için post-validation

Backfill'den sonra metadata fallback yolunun (`ingest.service.ts:103-108`)
güvenle kaldırılabilmesi için aşağıdaki iki query 0 dönmelidir:

```sql
-- 1. NULL FK + parsable sourceKey + eşleşen planItem var → matchable kaldı mı?
SELECT COUNT(*) FROM ingest_jobs j
 JOIN ingest_plan_items pi ON pi.source_key = j.metadata->>'ingestPlanSourceKey'
 WHERE j.plan_item_id IS NULL
   AND j.metadata->>'ingestPlanSourceKey' IS NOT NULL;
-- Beklenen: 0

-- 2. Production'da yeni gelen request'lerde fallback path tetikleniyor mu?
-- (api access log'larından grep; UI tarafı zaten disabled panel.)
SELECT COUNT(*) FROM ingest_jobs
 WHERE plan_item_id IS NULL
   AND metadata->>'ingestPlanSourceKey' IS NOT NULL
   AND created_at > <PR-2a deploy ts>;
-- Beklenen: 0  (yeni metadata-key path'inden geçen kayıt olmaması; UI panel disabled).
```

İkinci query'de `> 0` ise:
- Beklenmeyen frontend / external client metadata key gönderiyor; PR-2c'ye
  geçilmez. Önce kaynağı tespit edilip canonical `planItemId` body'ye geçirilir.

## 9. Bu PR'da çalıştırılmaz — açık not

Bu runbook A2 PR-2b kapsamında **referans** olarak repoya eklendi. Bu PR ile:

- Komutlar production'da koşturulmadı.
- DB write yapılmadı.
- A4 metadata DROP yapılmadı.
- PR-2c (fallback removal) yapılmadı.

Gerçek çalıştırma ayrı bir patron onay turunda + maintenance window'da yapılır.
