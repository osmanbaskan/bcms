# Migration Baseline-Absent — Tasarım Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Implement çoklu PR olarak kademeli, **measurement-first** disiplinde.
> **Audit referansı**: `BCMS_AUDIT_REPORT_2026-05-01.md` Section 2 HIGH-001 — Migration baseline-absent 🔴 (FS-name drift component'i `05829f8` ile ✅ kapandı; baseline-absent core problem hâlâ açık).
> **Pattern referansı**: `ops/REQUIREMENTS-S3-BACKUP.md` (`9925422`), `ops/REQUIREMENTS-NOTIFICATION-DELIVERY.md` (`9be627a`), `ops/REQUIREMENTS-MAINTENANCE-PATTERN.md` (`cc6d688`) — design-first, decisions-pending zincirinin dördüncüsü.

## Amaç

Clean PG'ye `prisma migrate deploy` çalıştırıldığında **ilk migration fail oluyor**: `20260416000000_add_matches` "relation 'schedules' does not exist" hatasıyla. Çünkü `add_matches` `schedules`/`bookings`'e ALTER yapıyor — bu tablolar lokal DB'de 2026-04-22 baseline'ında yaratıldı, ama **baseline DDL'i FS'te yok**.

**Etki**:
- ❌ CI/CD clean-DB build kırık
- ❌ Yeni dev env "fresh setup" kırık
- ❌ Staging environment provisioning kırık
- ❌ DR kapsamında: pg_dump restore + `migrate deploy` kombinasyonu (eğer kullanılırsa) kırık (genelde restore tek başına yeterli)
- ✅ Mevcut prod çalışıyor (DDL'ler zaten DB'de, `migrate deploy` checksum mismatch atmıyor)

Bu doc, problem'i çözmeden önce **ölçüm aracı** kurmayı, sonra strateji seçimini empirik olarak yapmayı tasarlar. Naive "8 dosya ekleyelim" yaklaşımı **sahte güven üretir** — sebepler aşağıda.

---

## 1. Mevcut State Verify (read-only)

### FS migrations (27 directory)
```
20260416000000_add_matches
20260420000000_schedule_finished_at_and_timestamps
20260420000001_match_opta_uid
20260421000000_mark_live_plan_schedules
20260422000000_schedule_usage_scope_column
20260422000001_cleanup_live_plan_metadata_usage_scope
20260422000002_schedule_usage_scope_constraint
20260422000003_schedule_reporting_dimensions
... (toplam 27)
```

### `_prisma_migrations` DB state (5 oldest by `started_at`)
```
migration_name                                          started_at
20260420000000_schedule_finished_at_and_timestamps      2026-04-22 18:46:02
20260422000001_cleanup_live_plan_metadata_usage_scope   2026-04-22 18:46:06
20260422000003_schedule_reporting_dimensions            2026-04-22 18:46:08
20260423001000_studio_plan_catalog                      2026-04-23 11:27:40
20260423002000_ingest_plan_items                        2026-04-23 12:48:55
```

⚠️ **Kritik gözlem**: `20260416000000_add_matches` filename'i en eski ama `_prisma_migrations`'ta **5'inci sırada değil, sonra geliyor** (started_at 2026-04-23+). Bu, `migrate resolve --applied` ile retroactively kaydedildiğini gösterir. **Filename ordering ≠ application ordering**. Replay'de filename order kullanılır → `add_matches` ilk sırada → fail. Ama prod'a `add_matches`'ten önce baseline + sonraki migration'lar uygulanmış, bu yüzden `add_matches`'in beklediği `schedules` tablosu mevcuttu.

### DB extensions
```
extname     extversion
plpgsql     1.0          -- default, her PG'de var
btree_gist  1.7          -- ⚠️ MANUAL INJECTION, hiç migration'da yok
```

`btree_gist` ingest port overlap GiST exclusion + schedule channel-overlap GiST exclusion için zorunlu, ama hiçbir migration `CREATE EXTENSION btree_gist` çağrısı yapmıyor. Audit raporundaki "manuel injection" notu doğrulandı — clean PG'ye replay denenirse `btree_gist` yok varsayımıyla başlar, ilk GiST migration'ı (`20260426000000_ingest_port_no_overlap`) fail eder (zaten `add_matches` öncesinde fail oluyor; `btree_gist` ikinci dalga problem).

### Baseline migration listesi (FS'te eksik)
2026-04-22 öncesi prod'a uygulanmış DDL ama FS'te dosyası olmayan migration'lar — listesi `_prisma_migrations`'ta da yok (orada en eski `20260420000000` görünüyor). Bu DDL'ler:
- `schedules` table CREATE
- `bookings` table CREATE
- `leagues` table CREATE
- `teams` table CREATE
- `channels` table CREATE
- `audit_logs` table CREATE
- `incidents` table CREATE
- (muhtemelen daha fazla — tam liste belirsiz)

Her tablo'nun ilk yaratıldığı andaki **kolon set, kolon tip, default, FK**, ve **ara migration'larda yapılan değişiklikler** FS'te yok. Bugünkü DB tek snapshot olarak görülüyor; geçmiş halleri (timeline) kayıp.

---

## 2. Naive Çözümlerin Risk Analizi

### Naive (B) "8 dosya ekleyelim" neden sahte güven üretir
- **Sıra belirsizliği**: 8 baseline migration arasında hangi adım hangi tablo'yu yarattı bilinmiyor. Tek `pg_dump` snapshot tüm tabloları "var" olarak gösterir, sırayı kaybeder.
- **Ara şema halleri**: Eğer baseline-1'de bir tablo yaratılıp baseline-3'te kolon eklenip baseline-5'te constraint düşürüldüyse, bugünden bakınca sadece son state'i görüyoruz.
- **27 sonraki migration'ın varsayımları**: Sonraki migration'lar baseline'ın **tam halini** bilerek yazıldı. Reverse-engineer edilmiş 8 migration replay edilirken sonraki migration'ın varsayımı bozulursa fail.
- **Test koşulu olmadan kanıt yok**: Reverse-engineer edilmiş baseline replay'de "no error" çıksa bile, gerçek pre-baseline migration'ın eşitliğini kanıtlamaz. Sadece "syntactically valid SQL" kanıtlar.

### Naive (A) "full squash with `pg_dump --schema-only`" neden kırık
- `pg_dump --schema-only` mevcut tablolar + constraint'ler + index'leri tek dosyada üretir
- Ama mevcut FS migration'ları aynı tabloların subsetlerine ALTER ediyor (örn. `add_matches` `schedules.match_id` ALTER, `add_fks_indexes_cascade_timestamptz` index'ler ekliyor)
- Replay sırasında: `000_baseline` `schedules` yaratır + `match_id` kolonu içerir + index'ler kurar → sonraki `add_matches` migration aynı `match_id` kolonu eklemeye çalışır → "column already exists" fail
- **Squash + archive eski migration'lar** kombinasyonu (eskileri sil, sadece baseline kalsın) yaklaşımı bu çakışmayı çözer ama mevcut migration history'yi kaybeder

### Cross-cutting risk: clean-room replay test koşulu yok
- "Replay başarılı" demek için gerçek bir clean PG container'a fresh setup test edilmeli
- Şu an manual yapıldı (audit raporunda btree_gist injection ile, kısmi)
- Otomatik harness olmadan strateji karşılaştırması mümkün değil

---

## 3. Measurement-First Disiplini

**Karar**: Strateji seçmeden önce **ölçüm aracı kuruyoruz**. Stratejiler sadece harness sonucu sonrasında karşılaştırılır. **B preferred hypothesis** olabilir (mevcut history'yi en az bozma argümanı geçerli) ama **default decision değil** — empirik kanıt zorunlu.

### Clean-Room Replay Harness — Tasarım

`ops/scripts/migration-replay-test.sh` (yeni, PR-1 deliverable):
```bash
#!/bin/bash
# Clean PG container yarat → migration replay → schema diff vs prod-snapshot
set -euo pipefail

# 1. Prod schema snapshot
docker exec bcms_postgres pg_dump -U bcms_user -d bcms --schema-only --no-owner > /tmp/prod-schema.sql

# 2. Clean PG container yarat (geçici)
docker run -d --name pg-replay-test -e POSTGRES_PASSWORD=test postgres:16
sleep 5

# 3. Database yarat
docker exec pg-replay-test psql -U postgres -c "CREATE DATABASE bcms_test;"

# 4. (PR-2'de gelecek değişikliğe göre) FS migrations'ı uygula
docker exec pg-replay-test psql -U postgres -d bcms_test -f /migrations/...

# 5. Replay sonrası schema dump
docker exec pg-replay-test pg_dump -U postgres -d bcms_test --schema-only --no-owner > /tmp/replay-schema.sql

# 6. Diff
diff /tmp/prod-schema.sql /tmp/replay-schema.sql
EXIT_CODE=$?

# 7. Cleanup
docker rm -f pg-replay-test

exit $EXIT_CODE
```

**Verify kriteri**:
- ✅ Clean: replay başarılı + schema diff sıfır → strateji çalışıyor
- ❌ Fail: replay error → strateji bozuk
- ⚠️ Diff: replay başarılı ama schema fark var → strateji eşit DB üretmiyor (çoğu durumda bug)

---

## 4. Karar Matrisi (kullanıcı input bekleyen)

| # | Karar | Seçenekler | Default önerim |
|---|---|---|---|
| 1 | **Strateji seçimi** | (A) Full squash + archive / (B) Pre-baseline reconstruction / (C) `prisma db pull` + manual split / (D) Paradigm shift `db push` (sadece fresh env) | **Measurement-first** — clean-room harness kurulup A vs B prototype karşılaştırılır; **preferred hypothesis B** (history koruma argümanı), final karar harness sonucu sonrası |
| 2 | **Migration archive politikası** | (i) `apps/api/prisma/migrations/_archive/` / (ii) Git history'de kalır, FS'ten delete / (iii) Yeni branch'te tutulur | **(i) `_archive/` dir** — FS'te accessible, replay'e dahil değil (Prisma `_` prefix'i ignore eder) |
| 3 | **Extension management** | (i) Yeni `00000000000000_extensions/migration.sql` (`CREATE EXTENSION btree_gist`) / (ii) Postgres image init script (`infra/postgres/init/`) / (iii) Manual SQL outside migration | **(i) Migration içinde** — replay self-contained, fresh env'de extension automatically yüklenir |
| 4 | **Prod `_prisma_migrations` touch** | (i) Hayır, fresh env replay tek hedef / (ii) Evet, prod'da da temiz history / (iii) Hibrit, sadece gerekli ise | **(i) Hayır** — prod sağlıklı, fresh env'i düzeltmek için prod-touch şart değil; sadece açık gerekçe varsa ayrı risk review PR'ı |
| 5 | **CI clean-room replay gate** | (i) Her PR'da otomatik harness / (ii) Sadece migration dizini değiştiğinde / (iii) Manual trigger | **(ii) Migration touch detection** — her PR'da çalışırsa CI yavaşlar; sadece ilgili dosya değişiminde tetikle |
| 6 | **Strategy experiment scope** | (i) A vs B tam prototip / (ii) Sadece B prototip + sonuç negatifse A planla / (iii) İlk olarak A (en kesin), sonra B opsiyonel | **(i) A vs B paralel prototip** — empirik karşılaştırma, hangi strateji daha az kod + daha az risk |
| 7 | **Harness'ın mevcut prod-snapshot kullanımı** | (i) Live prod'dan pg_dump al, harness'ta diff için kullan / (ii) Static snapshot dosyası, manuel update / (iii) Harness'a expected schema gömülü | **(i) Live prod-snapshot** — harness her run'da prod state ile sync; CI ortamında prod erişimi yoksa snapshot dosyası fallback |

---

## 5. Implementation PR Sıralaması (revised)

### PR-1: Clean-room replay verification harness
- `ops/scripts/migration-replay-test.sh` (Bash veya Node script)
- Docker test container management
- Schema diff helper (pg_dump comparison)
- Read-only initial test: mevcut FS replay sonucunu raporla (beklenen: fail at `add_matches`)
- Çıktı: harness ready, mevcut state baseline measurement (replay fails on migration #1)
- **No FS migration changes** — sadece ölçüm aracı

### PR-2: Strategy experiment + comparison report
- Branch `experiment/strategy-A-squash`: full squash prototype, harness'tan geçir
- Branch `experiment/strategy-B-reconstruction`: pre-baseline reconstruction prototype, harness'tan geçir
- Deliverable: `ops/MIGRATION-STRATEGY-EXPERIMENT.md` — empirik karşılaştırma raporu (line count, replay time, schema diff sonucu, risk profili)
- **No production change** — sadece experiment dalları
- Bu PR'ın merge'i strateji seçimi anlamına gelmez; karar matrisi #1 için input verir

### PR-3: Selected strategy applied
- PR-2 sonucundan seçilen strateji main'e uygulanır
- `apps/api/prisma/migrations/` directory yapısı revize
- (Eğer (B) seçilirse) reconstructed baseline migration'lar başa eklenir
- (Eğer (A) seçilirse) squash baseline + archive eski migration'lar
- Karar matrisi #3 extension migration eklenir
- Harness pass: clean replay başarılı + schema diff sıfır
- Audit raporu Section 2 HIGH-001 status update

### PR-4: CI clean-room replay gate
- GitHub Actions / CI pipeline'a harness entegrasyonu
- Trigger: `apps/api/prisma/migrations/` dosyası değişen PR'larda
- Fail gate: replay başarısız → merge engellenir
- Audit raporu HIGH-001 closure (regression önleme katmanı)

### Opsiyonel PR (default no): Prod `_prisma_migrations` re-init
- **Sadece açık gerekçe varsa** açılır
- Risk review zorunlu (mevcut prod sağlıklı olduğu için touch riski yüksek)
- Bu doc kapsamı dışı — gerekçe ayrı review

---

## 6. Test Prosedürü (harness verify)

### (1) Initial state measurement (PR-1 sonrası)
```bash
ops/scripts/migration-replay-test.sh
# Beklenen çıktı: FAIL at 20260416000000_add_matches "relation schedules does not exist"
# Bu measurement baseline — strateji uygulanınca SUCCESS olmalı
```

### (2) Strategy A (squash) prototype test (PR-2)
```bash
git checkout experiment/strategy-A-squash
ops/scripts/migration-replay-test.sh
# Beklenen: SUCCESS, schema diff = 0
```

### (3) Strategy B (reconstruction) prototype test (PR-2)
```bash
git checkout experiment/strategy-B-reconstruction
ops/scripts/migration-replay-test.sh
# Beklenen: SUCCESS (eğer reverse-engineer accurate ise), schema diff = 0
# Eğer fail → B strategy bu repo için viable değil, A default'a düşer
```

### (4) Selected strategy verify (PR-3)
```bash
git checkout main
ops/scripts/migration-replay-test.sh
# Beklenen: SUCCESS, schema diff = 0 — HIGH-001 fresh-env replay closure
```

### (5) CI gate verify (PR-4)
- PR aç, migration dosyası değiştir, harness'ın otomatik çalıştığını + fail durumunda merge engellendiğini verify et

---

## 7. Implementation Trigger

PR-1 + PR-2 sırasıyla aşağıdaki kararlar verilir verilmez başlar:

1. ✅ Mevcut state verify edildi (FS=DB=27, btree_gist DB'de manual injection, started_at filename ordering uyuşmazlığı)
2. 🔴 Karar matrisi #1-#7 default'lar onaylandı mı, değişiklik var mı
3. 🔴 PR-1 harness language seçimi (Bash vs Node — mevcut `ops/scripts/` Bash ağırlıklı, Bash öneriliyor)
4. 🔴 CI tooling seçimi (eğer CI yoksa kurulması ayrı kapsam)

PR-3 ise PR-2 sonuçları sonrası açılır:
- A vs B karşılaştırma raporu user'a sunulur
- User strateji seçer (kararı empirik kanıtla destekler)
- PR-3 seçilen stratejiyi apply eder

PR-4 PR-3'ten sonra (CI gate ancak replay başarılı stratejiyi koruyabilir).

---

## 8. Audit & Risk Etkisi

| Senaryo | Şimdiki durum | Pattern kurulduktan sonra |
|---|---|---|
| Clean PG'ye fresh setup | ❌ FAIL at first migration | ✅ Replay başarılı |
| CI/CD clean-build | ❌ Pipeline kırık | ✅ Otomatik gate (PR-4) |
| Yeni dev env (developer onboarding) | ❌ Manual workaround | ✅ Tek komut: `migrate deploy` |
| Staging environment | ❌ Manual workaround | ✅ Tek komut |
| DR pg_dump restore + migrate deploy | ⚠️ Genelde restore tek başına yeterli, migrate deploy "no pending" demeli | ✅ Net davranış |
| Future migration regression | 🔴 Detect edilmez | ✅ CI gate yakalar (PR-4) |

**HIGH-001 closure path**: PR-1 + PR-2 + PR-3 = baseline-absent çözüldü. PR-4 = regression önleme. Audit raporu HIGH-001 → ✅.

---

## 9. Out of Scope (bu doc dışı)

- PR-1, PR-2, PR-3, PR-4 fiili implementation (kod yazılmadı, harness yok, experiment dalları yok)
- Prod `_prisma_migrations` touch (default no, ayrı risk review PR'ı)
- Prisma version upgrade (mevcut v5.22.0 yeterli; yeni baseline pattern ile uyumlu)
- Prisma `db push` paradigm shift (D seçeneği matrix'te ama default değil; tarihsel referans)
- CI/CD platform seçimi (GitHub Actions vs alternative — repo şu an GitHub'da, default GitHub Actions)
- Migration squash sırasında semantic drift detection (manual code review yeterli kabul edilir; otomatik tooling ayrı iş)
- Healthcheck design (ayrı follow-up; HIGH-001'le bağımsız)
