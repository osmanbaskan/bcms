# BCMS Audit Report — 2026-05-01

> **Status legend**: 🔴 açık · 🟡 partial · ✅ kapatıldı
> **Format**: İlk audit (2026-05-01) read-only modda hazırlandı; sonradan iteratif kritik review turlarıyla evrildi. Bu sürüm 5-bölümlü sadeleştirilmiş yapıya geçiş — eski detay ve tarihsel narrative Appendix'lere taşındı. **Mevcut rapor tek doğruluk kaynağı.**
> **Veri konvansiyonu**: Canlı sayaçlar (audit_logs total, container Up süresi vb.) snapshot'tır — yaklaşık değer + zaman damgası ile sunulur. Tam-sayı drift eder, doküman bunu reflect etmez. Section 5'te canlı verify komutları.

---

## 1. Executive Summary

| Severity | Açık | Kapatıldı | Toplam |
|---|---|---|---|
| 🔴 CRITICAL (code) | 0 | — | 0 |
| 🟠 OPS-CRITICAL aday | 1 | — | 1 |
| 🟠 HIGH | 1 🔴 + 2 🟡 | — | 3 |
| 🟡 MEDIUM | 4 🔴 | 1 | 5 |
| 🟢 LOW | 3 🔴 | 1 | 4 |

**Genel durum**: Production-ready, *host kaybı senaryosu hariç*. Code-critical gap yok; HIGH ve OPS-CRITICAL bulgular operasyonel hijyen + DR kapsamında. Race condition'lar DB-level GiST + P2002 catch ile defense-in-depth korunmuş.

**Açık riskler özet** (önceliklendirilmiş):
1. **Migration baseline-absent** (HIGH-001) — fresh env replay imkansız
2. **Off-host backup yok** (OPS-CRITICAL) — host kaybı = total veri kaybı
3. **Doc drift 4 dosyada** (HIGH-002) — AI ajan/yeni developer yanıltma riski
4. **OPTA observability eksik** (HIGH-003) — burst tekrar olursa görünmez
5. **Soft-delete schema redesign** (MED-001) — semantic karar yokluğu

**Kapatılan başlıca işler** (Section 3'te tablo):
- HIGH-001 FS-name drift (`05829f8`)
- HIGH-003 League dedupe + P2002 outer retry (`a0946c4`, `0d67c6e`)
- HIGH-002 doc drift büyük kısmı (`feed1d3`)
- LOW-1 + MED-005 UI dead code & canEdit reactive (`feed1d3`)

---

## 2. Open Risks

### HIGH-001 — Migration baseline-absent 🔴

**Sorun**: Clean PG'ye replay edildiğinde ilk migration (`20260416000000_add_matches`) "relation 'schedules' does not exist" hatasıyla fail oluyor. `add_matches` migration'ı `matches` tablosunu CREATE ederken aynı zamanda `schedules` ve `bookings`'e `match_id` kolonu ALTER ediyor — bu tablolar lokal DB'de 2026-04-22 baseline'ında yaratıldı, baseline DDL'i FS'te yok.

**Status**: FS-name drift ✅ `05829f8` ile kapatıldı (FS=DB=27); core baseline-absent 🔴 hâlâ açık.

⚠️ **Test kalitesi notu**: Clean-room replay testinde `btree_gist` extension manuel olarak inject edildi. Gerçek fresh env'de extension yok varsayımıyla replay denenmeli; extension migration içinde olmalı (`CREATE EXTENSION IF NOT EXISTS btree_gist`).

**Etki matrisi**:
| Senaryo | Etki |
|---|---|
| Mevcut prod | ✅ Çalışıyor (DDL'ler zaten DB'de) |
| Postgres backup → restore (DR) | 🟡 Code-level safe; DR güvencesi ancak off-host kopya + drill ile |
| CI/CD clean-build | ❌ Replay fail |
| Fresh dev env | ❌ Replay fail |
| Staging provisioning | ❌ Replay fail |

**Sonraki adım**: Ayrı tasarım dokümanı + clean-room kanıt PR'ı. Naive `pg_dump --schema-only` → `000_baseline` çözümü duplicate constraint/index/sequence hataları üretir (mevcut FS migration'ları aynı tabloları yeniden ALTER ediyor). Doğru tasarım: hangi migration archive'a, hangi `_prisma_migrations` re-init stratejisi staging dry-run gerektirir.

**Lokasyon**: `apps/api/prisma/migrations/` ve `_prisma_migrations` tablosu.

---

### OPS-CRITICAL — Off-host backup yok 🔴

**Sorun**: `postgres_backup` sidecar (commit `5f6e728`) günlük 03:00'te local Docker volume'a pg_dump alıyor. Off-site/off-host kopya yok.

**Etki**: Disk arızası / host kaybı / ransomware / dosya sistemi corruption → hem prod hem backup birlikte kaybolur. 1-7 gün arası tüm veri kayıp.

**Mevcut korumanın kapsamı**:
- ✅ Yanlışlıkla DROP TABLE / silme / mantıksal hata için 7-gün lookback
- ✅ DB corruption recovery
- ❌ Disk/host failure için **KORUMA YOK**

**Sonraki adım**: S3-compatible (B2/AWS/Wasabi/R2) provider seçimi + access key, sonra `9925422` requirements doc'taki Seçenek A (rclone sidecar) implementasyonu. Implementasyon PR'ı **kullanıcı kararları + credential bekliyor** (provider, bucket adı, region, retention, encryption).

**Severity rasyonalitesi**: "Tam OPS-CRITICAL" değil çünkü backup VAR. "Tam OK" değil çünkü kapsam dar (host'a bağımlı). **Aday** sınıfı: yarım mitigation, mitigation tamamlanırsa CRITICAL'dan düşer.

---

### HIGH-002 — Doc drift kalan 4 line 🟡

**Status**: `feed1d3` doc drift'in büyük kısmını kapattı; 4 line kalan kalıntı.

**Kalan drift** (live grep, son verify):
| Lokasyon | Eski wording | Düzeltme |
|---|---|---|
| `README.md:304` | "auth.ts plugin Admin token'ında SystemEng auto-augment yapıyor" | "Auto-augment kaldırıldı (`0220b3e`); Admin'in tam yetkisi `isAdminPrincipal` early return ile" |
| `README.md:343` | "StudyoSefi, SystemEng ve Admin tam yetkili" | reports için Admin-only (rbac.ts: `reports.{read,export} = ['Admin']`) |
| `ops/NOTES_FOR_CODEX.md:86` | "Admin ve SystemEng sistem genelinde tam yetkili" | "Sadece Admin tam yetkili" |
| `ops/README.md:154, 165` | "Admin/SystemEng tüm gruplarda tam yetkilidir" | "Admin tüm gruplarda; diğer gruplar `rbac.ts` PERMISSIONS map'ine göre" |

**AI agent risk**: `NOTES_FOR_CODEX.md:86` dosyanın açılış paragrafı; Codex/Claude ajanı buradan PERMISSIONS okursa SystemEng'e yanlış yetki ekleyebilir. En kritik kalan satır.

**Sonraki adım** (~15 dk):
1. Yukarıdaki 4 line düzeltilir
2. **Yapısal**: NOTES_FOR_CODEX'te PERMISSIONS matrisini tekrar etmek yerine `packages/shared/src/types/rbac.ts`'yi canonical kaynak olarak işaret et — drift kaynağını ortadan kaldır.

---

### HIGH-003 — OPTA League upsert burst observability 🟡

**Geçmiş olay**: 2026-04-30 saat 00:00–09:30 arası ~9.5 saatlik burst. Saatte ~31k league upsert (~528/dakika, ~8.8/saniye). Audit_logs'a ~205k satır (snapshot anında ~%36). Burst içinde League ratio %99.99. Root cause: API log retention yokluğunda caller belirlenemedi.

**Status**:
- Idempotent UPSERT dedupe ✅ `a0946c4` (League upsert'te eski + yeni değer aynıysa audit yazılmaz)
- P2002 outer retry ✅ `0d67c6e`
- Observability/alert + post-mortem 🔴 hâlâ açık

**P2002 retry — canonical desen** (opta.sync.routes.ts'te uygulandı):
```ts
withLeagueCreateConflictRetry(() =>
  fastify.prisma.$transaction(async (tx) => { ... })
)
```
- Outer wrapper ile tüm `$transaction` retry edilir (PG'nin aborted-tx semantiği nedeniyle inline catch çalışmaz)
- `isLeagueCodeUniqueConflict` predicate `meta.target` ile sadece `leagues.code` conflict'ini yakalar — match.create P2002'sini (matchUid) retry etmez
- Eşleşmeyen P2002 propagate olur (fail-safe throw)
- Max 2 attempt; retry sırasında `findMany` concurrent insert'i görür → leagueMap doğru doldurulur

⚠️ **Inline `try/catch` + `findUniqueOrThrow` ÇALIŞMAZ** — PG aborted-tx state'i nedeniyle. Outer retry zorunlu desen. Bu nüans race condition note'una gelecek refactor için kritik.

**Sonraki adım**:
1. Prometheus metric ekle (`opta_sync_league_upserts_total` saatlik diff, alert eşiği N/saat)
2. API log retention (Loki/Promtail veya json-file rotation) — gelecek burst post-mortem için
3. Caller-bazlı rate limit son seçenek; sıkı limit gerçek güncellemeleri kaçırma riski (warn-only ilk hafta önerilir)

**Etki**: Mevcut audit_logs ~565k / ~104 MB (snapshot 2026-05-01 geç saat). 90-gün retention ile temizlenecek, doğrudan zarar yok. Aynı pattern tekrar olursa milyonluk satır + retention job lock pressure.

---

### MED-001 — Soft-delete schema redesign 🔴

**Sorun**: 21 tabloda `deleted_at` kolonu var (live: `COUNT(DISTINCT) → 21`); sadece 1 tabloda (`shift_assignments`, `weekly-shift.routes.ts:144`) filter aktif. Diğer 20 tabloda kolonlar görmezden geliniyor. Inventory'de fiili soft-deleted satır sadece 1: `schedules.id=32`.

**Status**: Inventory ✅ tamamlandı. Karar: schema redesign 🔴 ayrı PR.

**Kapsam (schema redesign seviyesi)**:
- Prisma schema 21 model field değişikliği
- Raw SQL SELECT'ler (raporlar, audit serializer, import/export)
- Mevcut indexes ve `deleted_at IS NULL` partial unique constraints
- FK behavior — CASCADE/RESTRICT bağlamında etkileşim
- Audit serializer (`audit.ts`) deletedAt nasıl serialize ediyor

**Sıralama**:
1. Önce data cleanup decisions (Section 4) — schedules.id=32 + 3 orphan ingest_plan_items decision tamamlanır
2. Audit-traced maintenance pattern netleşir (yeni doğru desen)
3. Schema redesign uygulanır (ayrı tasarım PR'ı, staging dry-run + review)

**Eski tahmin yanlış**: "P1, 2-3 saat" → Gerçek: schema redesign, ayrı PR, geniş kapsam.

---

## 3. Closed / Partial Fixes (commit bazlı)

| Bulgu | Status | Commit | Not |
|---|---|---|---|
| HIGH-001 FS-name drift | ✅ | `05829f8` | 4 missing migration directory eklendi; baseline-absent ayrı problem |
| HIGH-002 Doc drift büyük kısmı | 🟡 | `feed1d3` | 4 line kalan (Section 2) |
| HIGH-003 League upsert dedupe | ✅ | `a0946c4` | findMany→create/update; idempotent çağrılarda 0 audit satırı |
| HIGH-003 P2002 outer retry | ✅ | `0d67c6e` | `withLeagueCreateConflictRetry` + dar predicate |
| LOW-1 schedule-list:2070 dead code | ✅ | `feed1d3` | Admin auto-augment satırı silindi |
| MED-005 studio-plan canEdit signal | ✅ | `feed1d3` | `_userGroups` signal pattern uygulandı |
| Schedules.id=32 deferral tracking | 📝 | `9c8b690` | Section 4'e taşındı |

---

## 4. Data Cleanup Decisions

**Tek prensip**: Production veri yazımı **ancak audit-traced maintenance path netleşince** yapılır. İki kural:
1. Raw SQL `DELETE`/`UPDATE` proje kuralı ihlali (`CLAUDE.md`: tüm yazımlar Prisma audit extension'dan geçmeli)
2. Standalone `new PrismaClient()` script'i de bypass eder; audit-traced olması için app'in `$extends`'li factory chain'i kullanılmalı

Bu nedenle aşağıdaki cleanup decision'lar **decision-ready ama write-deferred**.

### Decision item 1 — `schedules.id=32`

| Alan | Değer |
|---|---|
| Title | "Manchester United - Brentford" |
| Status | DRAFT |
| FK alanları | `channel_id` NULL, `match_id` NULL, booking 0 |
| `deleted_at` | 2026-04-28 09:13:50 (dolu) |
| OPTA bağlantı | `metadata.optaMatchId = "g2562231"` → `matches.id=6305` (gerçek maç) |
| Audit izi | sadece CREATE event (2026-04-21); soft-delete event bulunamadı |
| Mevcut görünürlük | live-plan listesinde görünür (filter yok) |

**Audit izinin yokluğu** ya raw SQL bypass ya audit plugin race ihtimali — kesin değil, daha geniş query gerekebilir. Konuyu burada açan ayrı işaret.

**Karar (defer)**: Kanonik aktif kayıt mı, hard delete mi — kullanıcı iş kararı. Audit-traced maintenance pattern netleşince uygulanır. MED-001 schema redesign PR'ı kapsamında.

### Decision item 2 — 3 orphan `ingest_plan_items`

| id | gün | saat | tip | not |
|---|---|---|---|---|
| 54 | 2026-04-25 | 13:30-15:30 | manual | - |
| 107 | 2026-04-26 | 14:30-16:30 | ingest-plan | yedek |
| 108 | 2026-04-26 | 14:30-16:30 | ingest-plan | - |

**Bağlantı kontrolü** (live psql, 0 hit her tabloda):
- `ingest_plan_items.job_id` (orphan satırlarda) → NULL
- `qc_reports` → 0
- `incidents.metadata.sourceKey` → 0
- `ingest_plan_item_ports` → 0

**Karar (defer)**: Cascade etki yok. **Aynı write-deferred prensibi**: audit-traced maintenance pattern + Prisma `deleteMany` üzerinden yapılır (raw SQL DELETE değil). id=32 ile birlikte ele alınır.

---

## 5. Verification Notes

### Snapshot konvansiyonu

Bu raporda canlı sayaçlar (audit_logs total, container Up süresi, FS migration count vb.) **snapshot**'tır — tam-sayı drift eder, doküman bunu reflect etmez. Yaklaşık değer + zaman damgası ile sunulur.

### Static iddialar (drift etmez, sadece kapatılırsa değişir)

- **21 tablo `deleted_at` kolonu** (schema-level, migration ile değişir)
- **4 dosya doc drift line ref'leri** (HIGH-002, kapatılmadıkça aynı)
- **`withLeagueCreateConflictRetry` outer pattern** (kod-level kanıt, opta.sync.routes.ts)
- **3 orphan ingest_plan_items id'leri** (54, 107, 108)
- **schedules.id=32 detayları** (tek soft-deleted satır)
- **27 FS migration / 27 DB migration** (FS-name drift kapalı, baseline-absent ayrı)

### Live counters (drift eder, audit anına ait)

- **audit_logs total**: ~565k satır / ~104 MB (snapshot: 2026-05-01 geç saat)
- **2026-04-30 burst pencere**: ~205k satır / ~%36 ratio (geçmiş olay; snapshot'ta sabit)
- **audit_logs son 24h**: ~297k (burst penceresine göre, snapshot)
- **Container Up süreleri**: değişken, sadece "healthy/Up" durum statik anlamlı

### Verify komutları (canlı re-check)

```bash
# Migration count (FS-name drift kontrolü)
ls apps/api/prisma/migrations/ | grep -v migration_lock.toml | wc -l

# Audit log durumu
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT count(*) AS total, pg_size_pretty(pg_total_relation_size('audit_logs')) AS size
  FROM audit_logs;
"

# Container health
docker ps --format "table {{.Names}}\t{{.Status}}"

# Soft-delete kolonu olan tablo sayısı
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT count(DISTINCT table_name) FROM information_schema.columns
  WHERE column_name='deleted_at';
"

# Schedules.id=32 mevcut durumu
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT id, title, status, channel_id, match_id, deleted_at FROM schedules WHERE id=32;
"

# Orphan ingest_plan_items
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT id, day_date, source_type FROM ingest_plan_items
  WHERE id NOT IN (SELECT plan_item_id FROM ingest_plan_item_ports);
"

# HIGH-002 kalan doc drift (4 line)
grep -n "Admin ve SystemEng\|Admin/SystemEng tüm\|auto-augment yapıyor" \
  README.md ops/README.md ops/NOTES_FOR_CODEX.md

# Type-check
(cd apps/api && npx tsc --noEmit) && (cd apps/web && npx tsc --noEmit)

# OPTA P2002 retry pattern (kod-level kanıt)
grep -n "withLeagueCreateConflictRetry\|isLeagueCodeUniqueConflict" \
  apps/api/src/modules/opta/opta.sync.routes.ts
```

---

## Appendix A — Diğer Açık Follow-up'lar

Pending iş listesi (ana rapor kapsamı dışı, commit notlarından + audit'ten):

| # | Konu | Bağlam |
|---|---|---|
| 1 | OPTA drift scan PR | `0ed06f9` ve `5ee459b` mesajları: `metadata.optaAppliedMatchDate` field + her sync'te tarama job'u atomik introduction |
| 2 | Backup compression fix | image v0.0.11 quirk |
| 3 | Tekyon /channels permission UX | Tekyon kanal seçemeyince 403, ya read-only public endpoint ya yetki ekleme |
| 4 | Channel-overlap cascade conflict resolution UX | OPTA cascade conflict yaşadığında kullanıcıya UI'da gösterme |
| 5 | Architecture decoupling | OPTA ingest vs cascade ayrıştırması |
| 6 | `bcms_grafana`, `bcms_prometheus` healthcheck eksik | Up ama healthy değil; ek olarak `bcms_worker`, `bcms_mailhog` da aynı durumda |
| 7 | Restore drill execution | `infra/postgres/RESTORE.md` runbook var, fiili drill kanıtı yok |
| 8 | API log retention (Loki/Promtail) | HIGH-003 ile bağlı, gelecek burst post-mortem için |
| 9 | MED-002 redundant GiST drop | `schedules` tablosunda `_no_channel_time_overlap` ve `_no_overlap` GiST exclusion'ları çakışıyor. Drop migration HIGH-001 baseline-absent çözüldükten sonra eklenmeli (replay senaryosunu daha karışık hale getirmesin) |

---

## Appendix B — False Positives Önlendi

Bug gibi görünen ama olmayanlar — gelecekteki audit'lerin tekrar tuzağa düşmemesi için belgelendi:

- **`ScheduleService.update` outside-transaction version check**: `findById`'de version'a bakıp 412 atıyor, ardından `tx.updateMany({ where: { id, version } })` ile gerçek lock — ikinci aşama race-safe. Sadece hız iyileştirmesi, bug değil.
- **`audit.ts` worker context phantom audit yazımı**: ALS store yoksa anlık `base.auditLog.createMany`, transaction rollback → audit kalır. Mevcut worker'lar atomic single-step yazıyor; transaction içinde failed write zaten en altta `try/catch` ile recoverable. Risk var ama somut bug üretmedi.
- **`config.ts:41 setInterval` SPA bootstrap'ta clear edilmiyor**: SPA root'ta token refresh için 60sn interval. Browser sekmesi kapanınca GC. Önceki audit'lerde "memory leak" denmişti — yanlış.
- **MatDialog `afterClosed()` ve MatSnackBar `onAction()` subscribe'lar**: complete-once observable'lar; auto-teardown var. Önceki audit'te yanlışlıkla CRITICAL listelendi.
- **RabbitMQ reconnect window race**: connection drop → close handler → 5sn sonra reconnect → consumers re-register var. Optional/dev mode'da fallback null-publisher; production'da `RABBITMQ_OPTIONAL=false` zaten throw eder.
- **`/metrics` endpoint auth'sız**: production'da nginx-arkasında, dış dünya görmüyor. Internal Prometheus pull pattern.
- **`opta-watcher` Node service kalıntısı**: `app.ts:122` çağrı var ama worker container env'inde listelenmemiş, runtime'da disabled (logs doğrulandı).

---

## Appendix C — LOW Findings (kabul edilebilir tech debt)

| # | Bulgu | Lokasyon | Not |
|---|---|---|---|
| LOW-2 | `users.routes.ts` PERMISSIONS namespace overload | `:107, 142, 148, 176, 231, 247` — User CRUD `PERMISSIONS.auditLogs.read` kullanıyor | Önerilen: yeni `PERMISSIONS.users.{read,write,delete}` namespace. Sadece kozmetik |
| LOW-3 | `audit.ts` 4 adet `as any` | `:75, 77, 97, 147` | Prisma `$extends` runtime API tipi reduce edilmiş; custom helper ile bypass mümkün ama bakım maliyeti |
| LOW-4 | `console.*` 4 yer | `apps/web/src/main.ts:5` + `apps/web/src/app/core/services/logger.service.ts:31-33` | LoggerService kanalı + bootstrap fallback. Beklenen seviye |

LOW-1 ve MED-005 `feed1d3` ile ✅ kapatıldı (Section 3 tablosunda).

---

## Appendix D — Review History

| Tarih | Tur | Yöntem | Çıktı |
|---|---|---|---|
| 2026-05-01 | İlk audit | 12.5 dk, 141 tool çağrısı (read-only) | `d074bcd` initial draft |
| 2026-05-01 | Triage + scope refinement | User feedback iteration | `5e3f238` sayı düzeltmeleri |
| 2026-05-01 | Spot fix turları | 8 commit (`feed1d3`, `05829f8`, `01dbe76`, `6d491e6`, `9b603f5`, `eac6454`, `9925422`, `73257b0`) | İncremental fix'ler + 4 placeholder migration directory |
| 2026-05-01 | OPTA P2002 retry | Kod fix + commit | `0d67c6e` `withLeagueCreateConflictRetry` |
| 2026-05-01 | Schedules.id=32 deferral tracking | Section 8 follow-up #9 | `9c8b690` |
| 2026-05-01 | Critical review pass-1 | 10 hata spot-fix | `faec08e` |
| 2026-05-01 | Critical review pass-2 | Grep-based sweep, 13 hata | `19d3450` |
| 2026-05-01 | Critical review pass-3 + rewrite | 9 yeni hata + 5-bölümlü sadeleştirme | bu sürüm |

**Pass-3 kazanımı**: Spot-fix döngüsü (pass-1 + pass-2) raporu yamalı bir belgeye çevirmişti. Kritik hata olan "race condition note inline catch öneriyordu" pass-3'te yakalandı — outer retry canonical'i Section 2 HIGH-003'e geldi. Cleanup principle (data-write deferred until audit-traced path) Section 4'te tekleştirildi.

---

*Bu rapor read-only audit ile başladı, iteratif kritik review'larla evrildi, pass-3'te 5-bölümlü yapıya yeniden yazıldı. Mevcut sürüm tek doğruluk kaynağı; eski detay/tarihsel narrative Appendix'lerde tutuldu. Aksiyon kararları kullanıcıda.*
