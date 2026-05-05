# AuditLog Partition Deploy Runbook

**Migration**: `20260505000002_audit_log_partition_v1`
**Tasarım**: `ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md`
**PR'lar**: PR-1A (`2a8014b`), PR-1B (`5811a67`)
**Rollback**: `ops/RUNBOOK-AUDITLOG-PARTITION-ROLLBACK.md`
**Versiyon**: 1.0 (2026-05-05)

Bu runbook PR-1A migration'ını **production'a deploy** etmek için adım sırasıdır. PR-1B (retention feature-detect) zaten merge edilmiş; bu runbook her iki PR'ı production'a aktarır. PR-1C (cron) + PR-1D (monitoring) + PR-1E (legacy cleanup) henüz pending; deploy sonrası ileride uygulanır.

> **Kritik kural**: Migration sırasında **hem API hem worker** audit_logs'a yazabilir. Sadece worker'ı durdurmak yetmez; **API write trafiği de kesilmeli** (kullanıcı istekleri audit log üretir). Row count parity check sadece migration sonrası ve traffic açılmadan önce eşit kalır.

---

## 0. Pre-deploy Çek-Listesi

- [ ] Maintenance window planlandı + duyuruldu (~15-30 dk; chunked copy ihtimali ile margin).
- [ ] **DB backup**: full DB backup tercih edilir (table-only minimum aşağıda).
- [ ] Disk free space: tahmini 2× `audit_logs` boyutu (data copy + legacy paralel duruyor).
- [ ] Replication status (varsa replica): lag normal; gerekirse replica geçici async.
- [ ] Team alignment: SystemEng + audit owner + rollback'i tetikleyebilecek kişi nöbette.
- [ ] Önceki PR'lar production image'da: PR-1A (Prisma schema composite PK) + PR-1B (retention feature-detect) build edildi.

### Backup komutları

```bash
# TERCİH EDİLEN: full DB backup (enum tipler + schema + tüm bağımlılıklar dahil)
docker compose exec postgres pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
  > /tmp/bcms_pre_audit_partition_$(date +%F-%H%M).sql

# MİNİMUM: tablo + enum type — ama table-only pg_dump enum type dump ETMEYEBİLİR.
# audit_log_action enum'u ayrı dump gerekirse:
docker compose exec postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --schema-only --type=audit_log_action \
  > /tmp/audit_log_action_type.sql
docker compose exec postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -t audit_logs \
  > /tmp/audit_logs_data.sql

# Tercih: full backup. Daha basit ve eksiksiz. Risk yoksa onu kullan.
```

---

## 1. Deploy Sequence (zorunlu sıra)

> **Kritik**: API ve worker AYRI durdurulur. API hâlâ açık iken worker durdurmak audit yazımını sıfırlamaz — user istekleri API'den geçip audit log üretmeye devam eder.

```
1. Ingress / maintenance mode aktive et
   - nginx maintenance page veya
   - Reverse proxy upstream'i bcms_api'den 503 page'e yönlendir
   → Public traffic API'ye ulaşmıyor

2. Worker durdur
   docker compose stop worker
   → Background audit yazımları (notification, ingest, bxf, opta) durur

3. API durdur (write traffic kesin sıfır)
   docker compose stop api
   → Hem public hem internal API write yok
   → audit_logs INSERT akışı kesin durdu

4. DB backup (yukarıdaki Pre-deploy §0 komutu)
   → Geri dönüş için zorunlu

5. Migration uygula
   docker compose run --rm api npx prisma migrate deploy
     # Veya migration SQL'ini doğrudan psql ile:
     # docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
     #   -f /tmp/migration.sql
   → DDL: audit_logs_v2 partitioned + sub-partitions + data copy + swap

6. DDL sanity check (§2 — *traffic açılmadan önce*, parity hâlâ doğru)

7. API yeni image ile başlat
   docker compose up -d --build api
   → /health endpoint yeşil olana kadar bekle
   docker compose ps  # api healthy

8. API smoke / health
   curl -fsSk https://beinport/health
   → 200 OK ve checks.database = "ok"

9. Worker yeni image ile başlat
   docker compose up -d --build worker
   → Audit yazımı geri açılır
   → isTablePartitioned cache fresh container; migration sonrası tablo görür
   → relkind='p' → drop_partition path aktive

10. Retention dry-run / partition sanity (§3)

11. Maintenance mode / ingress geri aç
    → Public traffic akar; yeni audit log'lar partitioned tabloya gider
```

### isTablePartitioned cache nüansı (PR-1B uyarısı)

`isTablePartitioned` sonucunu **process lifetime cache'liyor**. Bu deploy sırasında doğru çalışır:

- **Deploy öncesi worker** (eski kod, PR-1B yok): `deleteMany` aynen çalışıyor; cache yok.
- **Deploy sırası worker durdurulmuş**: cache irrelevant.
- **Deploy sonrası worker fresh container** (yeni kod, PR-1B var): boot'ta `isTablePartitioned` ilk çağrı → migration tamamlanmış → `relkind='p'` → cache `true` → partition path.

**Yanlış sıra senaryosu**: PR-1A migration deploy edilmeden önce yeni image worker başlatılırsa → cache `false` saplanır → fallback path. Container restart bile cache'i sıfırlar (process death). **Migration tamamlanmadan worker başlatma**.

---

## 2. DDL Sanity Check (Adım 6 — traffic açılmadan)

```sql
-- a) Partition count (16: 15 monthly + 1 default)
SELECT child.relname, pg_get_expr(child.relpartbound, child.oid) AS bound
FROM pg_inherits
JOIN pg_class child  ON pg_inherits.inhrelid  = child.oid
JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
WHERE parent.relname = 'audit_logs'
ORDER BY child.relname;
-- Beklenen: 16 satır

-- b) Row count parity (HEMEN ŞİMDİ; traffic açılmadan)
-- Traffic açılınca yeni audit'ler partitioned'a yazılır, legacy değişmez,
-- parity bozulur. Sadece migration sonrası bu check anlamlı.
SELECT
  (SELECT COUNT(*) FROM audit_logs)        AS partitioned_count,
  (SELECT COUNT(*) FROM audit_logs_legacy) AS legacy_count;
-- Beklenen: eşit

-- c) Sequence durumu
SELECT last_value, is_called FROM audit_logs_id_seq;
-- Beklenen: last_value >= MAX(id) FROM audit_logs

-- d) Composite PK existence
SELECT conname, pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class cl ON cl.oid = c.conrelid
WHERE cl.relname = 'audit_logs' AND c.contype = 'p';
-- Beklenen: PRIMARY KEY (id, "timestamp")
```

> **Parity check sırası**: bu §2 adım 6'da yapılmalı, **adım 9 ve 11'den önce**. Worker veya public traffic audit yazmaya başlarsa partitioned satır sayısı yükselir, parity bozulur.

---

## 3. Post-deploy Sanity (Adım 10 — worker başladıktan sonra)

```sql
-- Parent insert routing: trigger bir create işlemi (UI'dan veya API smoke)
-- Sonra:
SELECT tableoid::regclass AS landed_in, "user", action, timestamp
FROM audit_logs
WHERE "user" = 'admin'
ORDER BY timestamp DESC LIMIT 5;
-- Beklenen: landed_in = audit_logs_<current_year>_<month>
```

```bash
# Retention dry-run (worker container içinde)
docker compose exec -e AUDIT_RETENTION_DRY_RUN=true worker \
  node -e "
    const { PrismaClient } = require('@prisma/client');
    const { isTablePartitioned, findExpiredPartitions } = require('./dist/modules/audit/audit-retention.helpers.js');
    (async () => {
      const prisma = new PrismaClient();
      const part = await isTablePartitioned(prisma);
      console.log({ partitioned: part });
      if (part) {
        const cutoff = new Date(Date.now() - 90*86400_000);
        const expired = await findExpiredPartitions(prisma, cutoff);
        console.log({ expired: expired.map(e => e.name) });
      }
      await prisma.\$disconnect();
    })();
  "
# Beklenen: { partitioned: true, expired: [audit_logs_2025_06, ...] }
# (cutoff -90gün → 2025_06 ve eskileri expired olur)
```

Boot log'da görünmesi gereken:
- `Audit retention job configured` (retention service start)
- İlk runOnce sonrası: `{ strategy: 'drop_partition', cutoff, dropped, dryRun: false }` (production değer)

---

## 4. Failure / Hızlı Rollback

Migration başarısız olursa **adım 11 ÖNCESİNDE**:

→ `ops/RUNBOOK-AUDITLOG-PARTITION-ROLLBACK.md`'e geç. **İlk 24 saat içinde rollback safe**; sonrası audit kayıp riski.

Adım 11 sonrası (public traffic açıldıktan sonra) rollback senaryosu **24 saat içindeyse mümkün ama veri kaybı** olur (yeni partitioned tabloya yazılan audit'ler legacy'ye geri taşınmaz).

---

## 5. Operational İpuçları

### Chunked data copy (büyük hacim)

Migration SQL içindeki `INSERT INTO audit_logs_v2 SELECT * FROM audit_logs` 14M+ satırda yavaş ve büyük WAL üretir. Maintenance window dar ise:

```sql
-- Migration'ın 4. adımını bypass et (INSERT) ve manuel chunked yap:
INSERT INTO audit_logs_v2 SELECT * FROM audit_logs
  WHERE "timestamp" >= '2025-06-01' AND "timestamp" < '2025-07-01';
-- Her ay için tekrarla; aralarında VACUUM (otomatik async)
```

### Replication lag

Migration sırasında WAL üretimi yüksek; replica'lar lag yapar. İzle:

```sql
SELECT application_name, replay_lag FROM pg_stat_replication;
```

Lag > 60 sn olursa: maintenance window'u uzat veya replica'yı async olarak işaretle.

### Partition pruning verify

Deploy sonrası query planner partition pruning yapıyor mu:

```sql
EXPLAIN (ANALYZE, BUFFERS)
  SELECT COUNT(*) FROM audit_logs WHERE "timestamp" >= '2026-05-01';
-- Beklenen: sadece audit_logs_2026_05 partition'ı tarar; diğerlerine dokunmaz.
```

---

## 6. Sonraki PR'lar (Bu Runbook Dışı)

| PR | Kapsam | Bu deploy sonrası ne zaman? |
|---|---|---|
| PR-1C | Pre-create cron (app background service) | İlk deploy 1-2 hafta sonra |
| PR-1D | Prometheus monitoring (default partition row count) | Paralel; ileri ay başlamadan |
| PR-1E | Legacy cleanup (`audit_logs_legacy` DROP) | 7 gün sonra ops adım |

PR-1C eksikken default partition'a yeni timestamp'ler düşer (3 ay ileriye partition var; 90+ gün sonra cron yoksa default'a birikir). Bu yüzden PR-1C'yi 90 gün içinde merge etmek zorunlu.

---

## 7. Audit Trail

Bu deploy gerçekleştiğinde:

```
ops/post-deploy-records/<date>-auditlog-partition-deploy.md
```

İçeriği:
- Deploy timestamp (start/end)
- Maintenance window süresi
- Backup file path
- Sanity check sonuçları (partition count, parity, routing)
- Sorun varsa not

---

## 8. Yardım

- DBA / SystemEng: ilk müdahale.
- Audit owner: data integrity onayı.
- Sahibi: final deploy onayı + maintenance window açılış/kapanış bildirimi.
