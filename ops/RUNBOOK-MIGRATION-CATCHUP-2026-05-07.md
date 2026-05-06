# RUNBOOK — Production Migration Catch-up (2026-05-07)

**Kapsam:** Mayıs 6-7 commit'lerinde atılan 6 migration ve API/worker deploy alignment.
**Durum:** Plan fazı. **Bu runbook henüz çalıştırılmamıştır.** Apply ayrı oturumda, adım-adım onayla.

---

## 1. Bulgular (2026-05-07 keşif)

Production DB ve runtime'ın commit/code state ile uyumsuzluğu:

```sql
-- _prisma_migrations son kayıt:
SELECT migration_name FROM _prisma_migrations
 WHERE migration_name LIKE '202605%';
-- → (0 rows)
```

```sql
-- Yeni tabloların hiçbiri yok:
SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN
 ('outbox_events','live_plan_entries','transmission_satellites',
  'live_plan_technical_details','live_plan_transmission_segments');
-- → (0 rows)
```

```
$ docker ps --format '{{.Names}}\t{{.Status}}'
bcms_api      Up 35 hours (healthy)
bcms_worker   Up 35 hours
...
```

API container son rebuild ~2026-05-05; Mayıs 6-7 commit'leri (B1-B9 + outbox PR-A) **deploy edilmemiş**. Bu yüzden runtime healthy görünüyor — yeni kod yeni tablolara dokunmuyor (eski kod çalışıyor).

**Compose blocker:**
```
$ docker compose ps
error while interpolating services.prometheus.environment.PROMETHEUS_HEALTHCHECK_AUTH_B64:
required variable is missing
```
`docker compose up -d --build` adımı bu env yokken çalışmaz. Önce `.env` güncellenmeli (bkz `ops/RUNBOOK-SECRETS-ROTATION.md`) — runtime container'lar şu an direkt `docker exec` ile erişilebilir; ama rebuild için compose şart.

---

## 2. Apply edilecek 6 migration (sıralı)

| # | Migration | Boyut | Bağımlılık |
|---|-----------|-------|------------|
| 1 | `20260506000000_outbox_events` | outbox tablosu + status CHECK + idempotency_key kolonu | bağımsız |
| 2 | `20260506000001_outbox_idempotency_key` | partial unique index | (1) sonrası |
| 3 | `20260506000002_live_plan_entries_foundation` | live_plan_entries (metadata kolonlu) | bağımsız |
| 4 | `20260506000003_lookup_tables_foundation` | 25 lookup tablo + ~217 seed + `live_plan_entries.metadata DROP` | (3) ZORUNLU önce |
| 5 | `20260507000000_live_plan_technical_details_foundation` | technical_details + 47 FK + CHECK | (3) + (4) ZORUNLU |
| 6 | `20260507000001_live_plan_transmission_segments_foundation` | segments + 3 CHECK + 1 index | (3) ZORUNLU |

**Kritik bağımlılıklar:**
- Migration #4 satır 534: `ALTER TABLE "live_plan_entries" DROP COLUMN "metadata";` — **`IF EXISTS` YOK**. #3 önce başarıyla uygulanmalı.
- Migration #5 47 FK lookup tablolarına bağımlı (#4 önce).
- Migration #5 + #6 parent FK live_plan_entries.id'ye bağlı (#3 önce).

---

## 3. Pre-flight kontroller

### 3.1 Backup (ZORUNLU)
```bash
mkdir -p /home/ubuntu/Desktop/bcms-backups
docker exec bcms_postgres pg_dump -U bcms_user -d bcms --format=custom --file=/tmp/bcms-pre-catchup-2026-05-07.dump
docker cp bcms_postgres:/tmp/bcms-pre-catchup-2026-05-07.dump /home/ubuntu/Desktop/bcms-backups/
ls -la /home/ubuntu/Desktop/bcms-backups/bcms-pre-catchup-2026-05-07.dump  # boyut sanity
```

### 3.2 Migration SQL syntax-check (yerelde)
```bash
for m in 20260506000000_outbox_events 20260506000001_outbox_idempotency_key \
         20260506000002_live_plan_entries_foundation \
         20260506000003_lookup_tables_foundation \
         20260507000000_live_plan_technical_details_foundation \
         20260507000001_live_plan_transmission_segments_foundation; do
  echo "==> $m"
  wc -l "apps/api/prisma/migrations/$m/migration.sql"
done
```
Her migration'ı `BEGIN; ... ROLLBACK;` içinde dry-run etmek mümkün ama 25 lookup seed satırı uzun süren rollback yaratır. Backup yeterli güvence.

### 3.3 Schema drift kontrolü
Production şu an Mayıs öncesi state'de. `prisma db pull` ile şema çıkarıp commit'teki schema.prisma ile diff'le → Mayıs öncesi tablolar (schedules, bookings, audit_logs, vb.) drift YOK olmalı. Drift varsa migration apply öncesi açıklanmalı.

### 3.4 Compose env fix
```
PROMETHEUS_HEALTHCHECK_AUTH_B64=<base64 user:pass>
```
`.env`'e ekle. Detay: `ops/RUNBOOK-SECRETS-ROTATION.md`. Bu sorun çözülmeden adım 6 (rebuild) çalışmaz.

---

## 4. Apply procedure (her migration için)

Her migration için 3 adım:

### 4.A Migration SQL apply
```bash
docker cp apps/api/prisma/migrations/<MIGRATION_DIR>/migration.sql \
  bcms_postgres:/tmp/<MIGRATION_NAME>.sql
docker exec bcms_postgres psql -U bcms_user -d bcms \
  --single-transaction \
  --variable=ON_ERROR_STOP=1 \
  -f /tmp/<MIGRATION_NAME>.sql
```
`--single-transaction` + `ON_ERROR_STOP=1`: ilk hatada tüm migration rollback olur, kısmi state oluşmaz.

### 4.B Tablo doğrulama
```bash
docker exec bcms_postgres psql -U bcms_user -d bcms -c "\d <BEKLENEN_TABLO>"
```

### 4.C `_prisma_migrations` insert
```sql
INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
VALUES (
  gen_random_uuid()::text,
  '<sha256_of_migration_sql>',
  '<MIGRATION_NAME>',
  NOW(),
  NOW(),
  1
);
```

`checksum` üretimi (Prisma deploy ile aynı algoritma):
```bash
sha256sum apps/api/prisma/migrations/<DIR>/migration.sql | awk '{print $1}'
```

**Önemli:** Her migration için 4.A → 4.B → 4.C sırasıyla. 4.C başarısız olursa migration apply edildi ama Prisma "yapılmamış" sayar; sonraki `prisma migrate deploy` çağrılarında re-apply denenir → çakışma. 4.C atlanmamalı.

---

## 5. Compose env fix → API/worker rebuild

```bash
# 5.1 .env'e PROMETHEUS_HEALTHCHECK_AUTH_B64 ekle
# 5.2 Compose parse OK mi:
docker compose config >/dev/null && echo "compose OK"

# 5.3 Rebuild api + worker (DB değişiklikleri sonrası kod alignment):
docker compose up -d --build api worker

# 5.4 Healthcheck:
docker compose ps api worker
docker logs bcms_api --tail 50
```

**Worker özellikle önemli:** outbox-poller env-gated default false (PR-C1); ama `audit-retention`, `notifications` vb. yeni Prisma client schema ile çalışacak. Yeni model'lere worker code referans veriyorsa rebuild ZORUNLU.

---

## 6. Smoke tests (rebuild sonrası)

```bash
# 6.1 Health
curl -fsS http://localhost:3000/health | jq

# 6.2 Live-plan list (boş — henüz veri yok)
curl -fsS http://localhost:3000/api/v1/live-plan -H "Authorization: Bearer $TOKEN" | jq

# 6.3 Lookup list (M5-B4 seed: ~5-10 satır transmission_satellites)
curl -fsS http://localhost:3000/api/v1/live-plan/lookups/transmission_satellites \
  -H "Authorization: Bearer $TOKEN" | jq '.total'

# 6.4 Live-plan create + technical-details + segment (entry olmadan endpoint test edilemez):
ENTRY_ID=$(curl -fsS -X POST http://localhost:3000/api/v1/live-plan \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Smoke","eventStartTime":"2026-06-01T19:00:00Z","eventEndTime":"2026-06-01T21:00:00Z"}' \
  | jq -r '.id')
curl -fsS http://localhost:3000/api/v1/live-plan/$ENTRY_ID/technical-details -H "Authorization: Bearer $TOKEN" | jq
curl -fsS http://localhost:3000/api/v1/live-plan/$ENTRY_ID/segments -H "Authorization: Bearer $TOKEN" | jq

# 6.5 Outbox shadow gözlemi
docker exec bcms_postgres psql -U bcms_user -d bcms -c \
  "SELECT event_type, status, COUNT(*) FROM outbox_events GROUP BY 1,2"
# Beklenen: live_plan.created (status=published)
```

Her smoke testi başarısızlık → **migration apply çalışmış olabilir** ama deploy/runtime sorunu var; rollback şart değil, forward-fix değerlendir.

---

## 7. Rollback planı

### 7.A Migration apply sırasında hata (4.A FAIL)
`--single-transaction` sayesinde otomatik rollback. Sonraki migration'a geçilmez. Hata mesajı incelenir, migration SQL düzeltilir, yeni commit yapılır.

### 7.B Tüm apply başarılı, ama smoke FAIL
İki yol:
1. **Forward-fix**: kod tarafı bug → yeni commit + rebuild. Migration kalır.
2. **Full rollback**: backup restore.
   ```bash
   docker exec bcms_postgres dropdb -U bcms_user --force bcms
   docker exec bcms_postgres createdb -U bcms_user bcms
   docker cp /home/ubuntu/Desktop/bcms-backups/bcms-pre-catchup-2026-05-07.dump bcms_postgres:/tmp/
   docker exec bcms_postgres pg_restore -U bcms_user -d bcms --clean --if-exists \
     /tmp/bcms-pre-catchup-2026-05-07.dump
   docker compose up -d --force-recreate api worker
   ```

### 7.C Kısmi state (4.A bir migration sırasında crash, ama 4.C atlandı)
Kısmi state olabilir (örn. tablo oluşturuldu ama _prisma_migrations boş).
- DB durumu kontrol: `\dt`, `_prisma_migrations`
- Eksik 4.C insert'ü tamamla → tutarlı duruma getir
- Veya: full restore (7.B.2) — en güvenli.

---

## 8. Açık sorular / riskler

1. **Lookup tablo seed (~217 satır)** — production'da operatörün eklediği satırlarla çakışma riski. Ama tablolar yeni; çakışma olmaz. `ON CONFLICT DO NOTHING` zaten migration'da var (M5-B4).
2. **Worker outbox-poller** — `OUTBOX_POLLER_ENABLED` env değeri? Apply sonrası env'i okuyup karar ver. Default false → poller aktif değil; sadece outbox tablosuna yazımlar gidecek.
3. **Schedule/Booking/audit_logs tablolarındaki mevcut data** — backup öncesi son commit ne zaman? `pg_dump` herhangi bir transaction loss olmaması için API/worker geçici durdurulabilir (ama bu downtime; kullanıcının kabul etmesi gerek). Alternatif: live backup (PostgreSQL point-in-time consistent).
4. **Audit log volume** — _prisma_migrations insert sırasında audit extension tetiklenmez (manuel SQL); ancak migration sonrası API rebuild'te audit_logs tablosuna geçmiş write akışı yok. Risk düşük.
5. **Prisma engine version drift** — API container Mayıs öncesi prisma client'ı içeriyor olabilir; rebuild gerekli yeniden generate için.
6. **OPTA watcher (Python)** — bu migration'lardan etkilenmiyor ama API restart'a bağlı sync aksaklığı olabilir; tolerable.

---

## 9. Sonraki adımlar (bu runbook çalıştırıldıktan sonra)

- M5-B10 implementation (live-plan UI migration) için DB+API alignment temeli oluşmuş olur.
- Madde 2+7 PR-C2 (shadow→pending cut-over) için outbox tablosu hazır.
- Memory state'de "Phase 2 shadow tüm domain'lerde aktif" ifadesi artık prod ile uyumlu.

---

## 10. Onay/imza

Bu runbook çalıştırılmadan önce kullanıcı tarafından açık onay gerekir. Adım 4.A (migration apply) ve adım 7.B (rollback) **destructive**; her biri ayrı onay.

| Adım | Onay | Tarih |
|------|------|-------|
| Backup (3.1) | bekleniyor | — |
| Compose env fix (3.4 / 5.1) | bekleniyor | — |
| Migration #1 apply | bekleniyor | — |
| Migration #2 apply | bekleniyor | — |
| Migration #3 apply | bekleniyor | — |
| Migration #4 apply | bekleniyor | — |
| Migration #5 apply | bekleniyor | — |
| Migration #6 apply | bekleniyor | — |
| API/worker rebuild | bekleniyor | — |
| Smoke tests | bekleniyor | — |
