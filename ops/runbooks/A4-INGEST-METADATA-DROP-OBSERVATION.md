# A4 Ingest Metadata DROP — Gözlem Gate

**Durum:** GÖZLEM AŞAMASI — PR yazılmaz, migration yazılmaz, DROP yapılmaz.
**Bu dokümanda yer alan komutlar yalnız read-only (SELECT) doğrulamalardır.**

---

## 1. Mevcut durum özeti (PR-2c sonu, gözlem başlangıcı)

| Öğe | Değer |
|-----|-------|
| `origin/main` | `a3ccdd0` (`feat(ingest): remove metadata source key fallback`) |
| Production-role API image | `84507b455756` (deploy 2026-05-10T00:31:51Z) |
| Production-role worker image | `dc831a2f5f40` (aynı build) |
| Service-layer `metadata.ingestPlanSourceKey` resolver | **KAPALI** — `ingest.service.js` runtime'da fallback lookup fiziksel olarak silindi (`grep sourceKey` no match) |
| Backfill script | aktif kalır — `docker exec bcms_api node dist/scripts/backfill-ingest-plan-item-id.js [--execute]` (legacy DB satırlarının canonical onarımı için) |
| `IngestJob.metadata` Prisma field + `ingest_jobs.metadata` kolon | **MEVCUT** — generic JSON body olarak hâlâ kabul edilir; A4'te DROP edilecek |
| `IngestPlanItem` schema/data | etkilenmedi |
| Frontend `ingest-list.component.ts:1505-1512` "Canlı Yayın Planından Ingest" panel | `[disabled]="true"` (B5a Y5-7); reachable değil; A4-prep cleanup kapsamında silinecek (PR-2c kapsamı dışı) |

A1 (target_id FK SetNull) + A2 (PR-2a structured FK + PR-2b backfill + PR-2c fallback removal) + A3 (version optimistic locking) production-role'de yerleşik. **Sıradaki tek adım: A4 metadata kolon DROP.** Bu doküman A4'e geçmeden önce 1 haftalık gözlem süresinin protokolüdür.

---

## 2. Gözlem süresi

| Başlangıç | Beklenen bitiş | Süre |
|-----------|----------------|------|
| 2026-05-10T00:31:51Z (PR-2c image deploy zamanı) | 2026-05-17T00:31:51Z | 7 gün (DECISION V1 önerisi) |

Süre kısaltılabilir veya uzatılabilir; gerekçe operasyonel akış volume'üne bağlı:
- **Volume düşük (production-role stack'te `ingest_jobs` tablosu boş veya az satırlı):** süre kısaltılabilir; ama en az **3 tam gün** çalışan rejim gözlemi şart (haftaiçi/haftasonu yayın akış farkı).
- **Volume yüksek:** 7 gün altı kabul edilmesin; metadata path'inden gelen anomali sinyali ancak bir hafta içinde belirgin olur.

Çalışan stack'te `ingest_jobs` boş olduğu için (PR-2b post-validation `null_fk_matchable=0`, `metadata_only_after_pr2a=0` doğrulandı), **operasyonel ingest akışı henüz yoktur ya da oluşan kayıtlar arşivlendi/silindi.** Gözlem süresi içinde fiili ingest tetiklenirse şu sayıların 0 kalması beklenir.

---

## 3. Günlük read-only kontroller (5 query + 2 log probe)

Hepsi **SELECT-only**; yazma yok; raw SQL DDL/DML yazılmaz; `--execute` yok.

### Q1 — `metadata.ingestPlanSourceKey` ile yeni job oluşuyor mu? (gerçek anomali sinyali)

```bash
docker exec bcms_postgres psql -U bcms_user -d bcms -c "
SELECT COUNT(*) AS metadata_only_after_pr2c
FROM ingest_jobs
WHERE plan_item_id IS NULL
  AND metadata->>'ingestPlanSourceKey' IS NOT NULL
  AND created_at > '2026-05-10 00:31:51+00';
"
```

**Beklenen:** `0` (PR-2c image deploy ts'inden sonra fallback yolu kapalı; UI panel disabled; external metadata-path caller yok).

> `> 0` durumu KRİTİK: bilinmeyen bir caller hâlâ metadata-only request gönderiyor demektir. A4 DROP açılmaz; önce kaynak tespit edilir (api access log + caller user-agent inceleme). PR-2c rollback gerekebilir.

### Q2 — `planItemId IS NULL + matchable` kayıt birikiyor mu? (legacy onarım sinyali)

```bash
docker exec bcms_postgres psql -U bcms_user -d bcms -c "
SELECT COUNT(*) AS null_fk_matchable
FROM ingest_jobs j
JOIN ingest_plan_items pi ON pi.source_key = j.metadata->>'ingestPlanSourceKey'
WHERE j.plan_item_id IS NULL
  AND j.metadata->>'ingestPlanSourceKey' IS NOT NULL;
"
```

**Beklenen:** `0` (PR-2b post-validation 0 dönmüştü; PR-2c sonrası fallback kapalı, dolayısıyla yeni ekleme olmaması gerek).

> `> 0` durumu: yeni satırlar eklendiyse Q1 ile aynı kaynak; aynı satırlar Q1'de görünmüyorsa Q2 backfill script çalıştırılarak temizlenebilir (`--execute` ayrı onay turu).

### Q3 — Canonical `planItemId` set kayıtlar düzgün oluşuyor mu?

```bash
docker exec bcms_postgres psql -U bcms_user -d bcms -c "
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*) FILTER (WHERE plan_item_id IS NOT NULL) AS canonical_set,
  COUNT(*) FILTER (WHERE plan_item_id IS NULL)     AS canonical_null,
  COUNT(*) AS total
FROM ingest_jobs
WHERE created_at > '2026-05-10 00:31:51+00'
GROUP BY day
ORDER BY day DESC;
"
```

**Beklenen:** Her gün satırı için `canonical_set + canonical_null = total`; canonical_set oranı operasyonel ingest akışı planItem'a bağlı tetikleniyorsa yüksek olmalı. UI panel disabled iken yeni request volume'ü zaten 0; gerçek ingest watcher path'i `planItemId` set etmediği için `canonical_null` baskın olabilir — bu A4'ü engellemez, bilgi verir.

### Q4 — Ingest worker statü dağılımı normal mi? (worker hatası sinyali)

```bash
docker exec bcms_postgres psql -U bcms_user -d bcms -c "
SELECT status, COUNT(*) AS n
FROM ingest_jobs
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY status
ORDER BY n DESC;
"
```

**Beklenen:** `COMPLETED` baskın; `FAILED` 0 veya sınırlı; uzun süre `PENDING/PROCESSING/PROXY_GEN/QC` takılı kayıt YOK.

> `FAILED` artışı: A3 race korumasından bağımsız operasyonel hata (codec, FFmpeg, vb.); A4 gate'ini bloklamaz ama log'da incelenmeli.

### Q5 — Audit log ingest UPDATE oranı normal mi? (audit extension çalışıyor mu doğrulaması)

```bash
docker exec bcms_postgres psql -U bcms_user -d bcms -c "
SELECT
  date_trunc('day', created_at) AS day,
  COUNT(*) AS ingest_audit_rows
FROM audit_logs
WHERE entity_type = 'IngestJob'
  AND created_at > NOW() - INTERVAL '7 days'
GROUP BY day
ORDER BY day DESC;
"
```

**Beklenen:** Her ingest CREATE + UPDATE + finalize için audit satırı. Sıfır row + ingest_jobs aktif yazılıyorsa audit extension bypass var demektir → A4 öncesi araştırılır.

### L1 — API container ingest hatası

```bash
docker logs --since 24h bcms_api 2>&1 | grep -iE "ingest|error|warn" | tail -30
```

**Beklenen:** 5xx, P2022 (kolon yok), validateIngestSourcePath retdleri haricinde anormal kalıp YOK.

### L2 — Worker container ingest watcher/worker hatası

```bash
docker logs --since 24h bcms_worker 2>&1 | grep -iE "ingest.worker|ingest.watcher|error|warn" | tail -30
```

**Beklenen:** `ingest-worker` ve `ingest-watcher` `Background service started`; `INGEST_NEW` consume + ffprobe path'inde hata kalıbı YOK; `BCMS_PROXY_OUTPUT_DIR` warning kabul edilebilir (mevcut cosmetic uyarı).

---

## 4. A4 açma kriterleri (zorunlu — hepsi sağlanmadan A4 PR yazılmaz)

| # | Kriter | Doğrulama yöntemi |
|---|--------|-------------------|
| 1 | **`metadata_only_after_pr2c = 0`** gözlem süresi boyunca her gün | Q1 günlük 0 |
| 2 | **`null_fk_matchable = 0`** gözlem süresi boyunca | Q2 günlük 0 |
| 3 | Ingest worker `FAILED` oranı tabandan sapmamış | Q4 + L2 |
| 4 | Backfill script execute gerekmedi (matchable=0 sürdü) | Q2 + dry-run logları |
| 5 | Gözlem süresi tamamlandı (en az 3 tam gün, hedef 7 gün) | takvim |
| 6 | Production-role DB backup/snapshot planı hazır + alındı | DB ops onay (snapshot ts + path arşivlendi) |
| 7 | Audit extension ingest path'inde aktif (Q5 satır sayımı 0'dan büyük yeni ingest varsa, ya da ingest yok ise non-applicable) | Q5 |
| 8 | Frontend disabled panel hâlâ disabled (kazara reachable yapılmadı) | UI smoke + `grep "[disabled]=\"true\""` `ingest-list.component.ts` |
| 9 | Patron yazılı onay | imza |

---

## 5. A4 yapılacak işler taslağı (yalnız doc; bu PR'da uygulanmaz)

A4 PR scope'u (sıralı):

### A4-1 — Backend code
- `apps/api/prisma/schema.prisma` — `IngestJob.metadata Json?` alanı sil
- `apps/api/src/modules/ingest/ingest.service.ts` — `triggerManualIngest` `tx.ingestJob.create({ data: { ..., metadata: dto.metadata as Prisma.InputJsonValue } })` → `metadata` field'i create payload'undan kaldır; DTO'dan `metadata?: Record<string, unknown>` field sil
- `apps/api/src/modules/ingest/ingest.routes.ts` — Zod `createIngestSchema.metadata: z.record(...).optional()` field sil
- `packages/shared/src/types/ingest.ts` — `CreateIngestJobDto.metadata` + `IngestJob.metadata` field sil

### A4-2 — Migration
- `apps/api/prisma/migrations/<ts>_drop_ingest_job_metadata/migration.sql`:
  ```sql
  ALTER TABLE "ingest_jobs" DROP COLUMN "metadata";
  ```
- DECISION V1 §10/4 paritesi: ADD COLUMN ve DROP COLUMN aynı PR'da değildir; **A2 PR-2a bu kuralı tek yönde uyguladı** (ADD aynı PR'da, UPDATE ayrı runbook, DROP ayrı PR — bu A4 PR).
- DROP destructive: rollback için pre-snapshot **zorunlu**.

### A4-3 — Tests
- `apps/api/src/modules/ingest/ingest.service.integration.spec.ts` — `metadata` referanslı testler:
  - "PR-2c: metadata.ingestPlanSourceKey body'de gelse de resolver YOK..." — DTO'dan `metadata` field silindi; bu test güncellenmeli (Zod artık `metadata` body kabul etmiyor; 400 dönmeli)
  - "PR-2c: metadata key DB'de eşleşmese de davranış aynı..." — aynı şekilde
  - "planItemId + metadata birlikte" — aynı
- `apps/api/src/scripts/backfill-ingest-plan-item-id.integration.spec.ts` — A4 sonrası backfill artık çalışmaz (metadata kolon yok); script ya silinir ya da "no-op + warning" durumuna alınır. **Karar A4 PR yazılırken**.

### A4-4 — Backfill script tasfiyesi
A4 metadata DROP sonrası backfill script source'u (`metadata->>'ingestPlanSourceKey'`) kaybolur. İki seçenek:
- **A4-4a:** script + spec dosyalarını sil (`apps/api/src/scripts/`)
- **A4-4b:** script `process.exit(0) + console.log("metadata kolonu DROP edildi; bu script artık no-op")` ile koru (audit/historical run kayıt için)

### A4-5 — Frontend cleanup (A4-prep, ayrı PR)
- `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts:379-390` disabled panel sil
- Aynı dosyada `triggerLivePlanJob()` metoda + bağlı state field'lar (`livePlanCandidates`, `livePlanSourcePath`, `selectedScheduleId`, `triggering` vb.) — reachability tekrar kontrol edilerek silinir
- Bu PR-2c'den ayrı; A4 backend DROP'tan önce veya sonra yapılabilir (frontend body'de `metadata.ingestPlanSourceKey` gönderiyor; A4 sonrası Zod 400 dönecek, panel zaten disabled olduğu için runtime'da tetiklenmiyor — sıralama esnek)

### A4-6 — Production migration apply (ayrı runbook)
- `ops/runbooks/A4-INGEST-METADATA-DROP-EXECUTE.md` (ayrı doküman, A4 PR'ında yazılır):
  - Pre-snapshot zorunlu (DROP destructive)
  - `prisma migrate deploy` — yalnız tek migration
  - Smoke: `/api/v1/ingest` POST canonical body (`{sourcePath, planItemId}`) hâlâ 200
  - Smoke: aynı body'de `metadata` field gönderirse Zod 400 dönüyor mu
  - Rollback: snapshot'tan restore (DROP COLUMN reverse migration ekleyerek geri alınmaz; tüm production DB'yi snapshot ts'ine döndürmek gerekir)
- Onay zinciri: imza + maintenance window + DB ops + patron

### A4-7 — Doc + DECISION update
- `ops/DECISION-BACKEND-CANONICAL-DATA-MODEL-V1.md` §4.A4 — "DONE" işaretlenir
- Bu gözlem dokümanı A4 PR sonrası `ops/runbooks/archive/` veya silme; A4 PR commit body'sinde referans

---

## 6. Bu PR'ın kesin yasakları (A4 gözlem PR'ı kapsamı)

- ❌ Migration yok (`A4 yapılacak` listesi yalnız taslak)
- ❌ `IngestJob.metadata` DROP yok (Prisma schema değişmez)
- ❌ DB write yok (yalnız Q1-Q5 SELECT'leri günlük gözlemde çalıştırılır)
- ❌ Docker rebuild/restart yok (PR-2c image yerinde duruyor)
- ❌ Deploy yok
- ❌ Backfill `--execute` yok (matchable=0 olduğu sürece anlamsız)
- ❌ Code change yok (yalnız bu markdown dosyası eklendi)
- ❌ Git commit/push yok (bu doküman gözden geçirme + onay sonrası ayrı bir commit ile gider)

---

## 7. Operasyonel pozisyon

A4 gözlem fazı başladı. Günde bir kez (ya da en azından operasyonel ingest akışı tetiklendiğinde) Q1 ve Q2 query'leri çalıştırılır; sonuçlar bu dosyanın altında **§8 günlük log tablosuna** eklenir. 7 günün sonunda kriter listesi (§4) tek tek imzalanır; hepsi yeşil ise A4 PR yazımı için ayrı emir gelir.

---

## 8. Günlük gözlem log'u (operatör doldurur)

| Gün | Tarih (UTC) | Q1 result | Q2 result | Q3 not | Q4 not | Q5 not | L1 anomaly | L2 anomaly | İmza |
|-----|-------------|-----------|-----------|--------|--------|--------|-----------|-----------|------|
| 1 | 2026-05-10 | | | | | | | | |
| 2 | 2026-05-11 | | | | | | | | |
| 3 | 2026-05-12 | | | | | | | | |
| 4 | 2026-05-13 | | | | | | | | |
| 5 | 2026-05-14 | | | | | | | | |
| 6 | 2026-05-15 | | | | | | | | |
| 7 | 2026-05-16 | | | | | | | | |

İlk satır gözlem başlangıcı (PR-2c deploy günü); son satır A4 açma kararının verileceği gün.

---

## 9. Erken A4 açma sinyalleri (gözlem süresi kısaltılabilir)

- Q1 ve Q2 her gün 0
- Operasyonel ingest akışı volumesinin minimum 3 günü kapsadığı (PR-2b dry-run'da scanned=0 ise ek bir "ingest yok" yorumu; bu durum A4'ü hızlandırabilir çünkü DROP edilecek metadata kolonunda zaten veri yok)
- Patron + DB ops her ikisi de erken açmaya hazır

## 10. Erken A4 erteleme sinyalleri (gözlem süresi uzatılır)

- Q1 herhangi bir gün > 0 (kaynak tespit + temizlik gerekir)
- Q2 herhangi bir gün > 0
- L1/L2 anomalisi çıktı (P2022/P2025/Audit bypass)
- Backfill `--execute` çalıştırma kararı verildi (gözlem yeniden başlar; execute sonrası 1-3 gün ek gözlem)
