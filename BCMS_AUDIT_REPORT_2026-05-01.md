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
| 🟠 HIGH | 1 🔴 + 1 🟡 | 1 ✅ (HIGH-002) | 3 |
| 🟡 MEDIUM | 4 🔴 | 1 ✅ (MED-005) | 5 |
| 🟢 LOW | 3 🔴 | 1 ✅ (LOW-1) | 4 |

**Genel durum**: Production-ready, *host kaybı senaryosu hariç*. Code-critical gap yok; HIGH ve OPS-CRITICAL bulgular operasyonel hijyen + DR kapsamında. Race condition'lar DB-level GiST + P2002 catch ile defense-in-depth korunmuş.

**Açık riskler özet** (önceliklendirilmiş, post-fix durumu):
1. **Migration baseline-absent** (HIGH-001) 🔴 — fresh env replay imkansız
2. **Off-host backup yok** (OPS-CRITICAL) 🔴 — host kaybı = total veri kaybı
3. **OPTA notification delivery** (HIGH-003) 🟡 — detection ✅ kuruldu (metric + alert rule), notification katmanı (Alertmanager + Slack/email) eksik
4. **Soft-delete schema redesign** (MED-001) 🔴 — semantic karar yokluğu, ayrı PR

**Kapatılan başlıca işler** (Section 3'te tablo):
- **HIGH-002 doc drift tamamen kapatıldı** ✅ (`feed1d3` + `90c8779`) — son sweep'te kalan 17 line + canonical SystemEng tablosu
- HIGH-003 detection katmanı ✅ (`a0946c4` dedupe, `0d67c6e` P2002 retry, `4e364f3` metric + alerts)
- HIGH-001 FS-name drift ✅ (`05829f8`) — ama core baseline-absent açık
- LOW-1 + MED-005 ✅ (`feed1d3`) — UI dead code & canEdit reactive

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

**Design doc**: `ops/REQUIREMENTS-MIGRATION-BASELINE.md` (`2e2b6a4`) — measurement-first strategy selection, decision-ready / implementation-scoped. Naive "8 dosya ekleyelim" sahte güven riski yerine clean-room replay harness ile A vs B prototype karşılaştırması.

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

**Design doc**: `ops/REQUIREMENTS-S3-BACKUP.md` (`9925422`) — S3-compatible provider matrix (MinIO / B2 / AWS S3 / Wasabi / R2), retention/encryption/sync-tool kararları, decision-ready / implementation-scoped (credential + provider seçimi bekliyor).

---

### HIGH-002 — Doc drift ✅ KAPATILDI

**Status**: ✅ **Kapatıldı** (`feed1d3` ilk büyük kısmı + `90c8779` kalan sweep). Live verify: 0 stale hit (Pattern A/B/C/D/E/F sweep, README + ops/README + ops/NOTES_FOR_CODEX).

**Kapsam ve yöntem**:
- `feed1d3`: RBAC restructure docs first-pass alignment (~10 paragraf düzeltildi)
- `90c8779`: kalan 17 line sweep — booking/weekly-shift wording, per-module RBAC matrix tablosu (124-133 ops/README), NOTES_FOR_CODEX:371 stale parenthetical
- **Yapısal eklenti**: `ops/NOTES_FOR_CODEX.md`'a "SystemEng Yetki Kapsamı — Canonical Tablo" eklendi; sekme bazında SystemEng yetkileri tek kaynaktan okunabilir, doc'larda tekrar etmek yerine bu tabloya işaret edilir → drift kaynağı kapatıldı

**Sonraki audit önlem**: Sweep'te kullanılan 6 pattern (`Admin/SystemEng`, `Admin ve SystemEng`, backtick variant, `SystemEng.*tüm grup`, `SystemEng.*tam yetki`, `SystemEng,\s*Admin`) gelecekte yeni RBAC değişikliği olursa tekrar çalıştırılır.

---

### HIGH-003 — OPTA League upsert burst observability 🟡

**Geçmiş olay**: 2026-04-30 saat 00:00–09:30 arası ~9.5 saatlik burst. Saatte ~31k league upsert (~528/dakika, ~8.8/saniye). Audit_logs'a ~205k satır (snapshot anında ~%36). Burst içinde League ratio %99.99. Root cause: API log retention yokluğunda caller belirlenemedi.

**Status — detection vs notification ayrımı**:
- **Detection katmanı** ✅:
  - Idempotent UPSERT dedupe `a0946c4` (League upsert'te eski + yeni değer aynıysa audit yazılmaz)
  - P2002 outer retry `0d67c6e` (concurrent sync race)
  - **Metric** `bcms_opta_league_sync_total{action="create|update|skip"}` `4e364f3` (3 label sıfırla initialize)
  - **Alert rules** `infra/prometheus/alerts.yml`:
    - `OptaLeagueSyncBurst`: `sum(increase(...[1h])) > 500` (caller anomali, post-dedupe skip-heavy senaryosunu yakalar)
    - `OptaLeagueWriteBurst`: `sum(increase(...{action=~"create|update"}[1h])) > 200` (gerçek DB write hızı)
  - Prometheus rules loaded; firing state Prometheus UI/API'de görünür (`/api/v1/alerts`)
- **Notification katmanı** 🔴:
  - **Alertmanager** kurulu değil; firing alert'ler operasyonel alarm üretmiyor
  - Slack/email/PagerDuty webhook routing yok
  - Senaryo: "burst oldu, Prometheus 'firing' diyor, kimse bakmıyor" hâlâ mümkün
  - Post-hoc: tarih + sayım izlenebilir; proaktif uyarı **yok**
- **Caller post-mortem** 🔴: API log retention (Loki/Promtail veya json-file rotation) hâlâ kurulmamış

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

**Sonraki adımlar** (kalan iş):
1. **Notification delivery** (öncelikli kalan iş): Alertmanager container + route config + webhook delivery (Slack veya email). Secret/webhook yönetimi gerekir, ayrı kapsam.
2. **API log retention** (Loki/Promtail veya json-file rotation) — gelecek burst caller post-mortem için
3. **Caller-bazlı rate limit** son seçenek; sıkı limit gerçek güncellemeleri kaçırma riski (warn-only ilk hafta önerilir)

**Etki**: Mevcut audit_logs ~565k / ~104 MB (snapshot 2026-05-01 geç saat). 90-gün retention ile temizlenecek, doğrudan zarar yok. Aynı pattern tekrar olursa milyonluk satır + retention job lock pressure. Notification delivery kuruluncaya kadar **proaktif alarm yok**, ama detection veri katmanı hazır (post-hoc analiz ve manuel monitoring mümkün).

**Notification design doc**: `ops/REQUIREMENTS-NOTIFICATION-DELIVERY.md` (`9be627a`) — Alertmanager + routing + secret yönetimi (4 alternatif analizi), mesaj format prensipleri, layer-isolated test prosedürü, decision-ready / implementation-scoped (Slack webhook + secret yöntemi bekliyor).

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

**Maintenance pattern doc**: `ops/REQUIREMENTS-MAINTENANCE-PATTERN.md` (`cc6d688`) — audit-traced entry-point design (app-booted one-off command, no HTTP attack surface), `audit_logs.metadata` schema prerequisite, transaction-aware queue+flush pattern, decision-ready / implementation-scoped. Bu pattern aynı zamanda **MED-003 orphan ingest_plan_items** ve **schedules.id=32 cleanup**'larını da unblock eder.

---

## 3. Closed / Partial Fixes (commit bazlı)

Tablo "component fix" granülünde — her satır bir kod/doc commit'ini gösterir. **Bulgu overall status'u Section 1 sayım tablosunda** ayrı tutulur (örn. HIGH-003 component'leri ✅ ama bulgu overall 🟡 partial; HIGH-001 FS-name component'i ✅ ama bulgu overall 🔴 — baseline-absent açık).

| Component fix | Bulgu | Component status | Commit | Not |
|---|---|---|---|---|
| FS-name migration drift | HIGH-001 (overall 🔴) | ✅ | `05829f8` | 4 missing migration directory eklendi; baseline-absent ayrı problem |
| RBAC docs first-pass alignment | HIGH-002 (overall ✅) | ✅ | `feed1d3` | İlk büyük kısmı kapatıldı |
| RBAC docs final sweep | HIGH-002 (overall ✅) | ✅ | `90c8779` | Kalan 17 line + canonical SystemEng tablosu — drift kaynağı kapandı |
| League upsert audit dedupe | HIGH-003 (overall 🟡) | ✅ | `a0946c4` | findMany→create/update; idempotent çağrılarda 0 audit satırı |
| P2002 outer transaction retry | HIGH-003 (overall 🟡) | ✅ | `0d67c6e` | `withLeagueCreateConflictRetry` + dar predicate |
| Prometheus metric + alert rules | HIGH-003 (overall 🟡) | ✅ | `4e364f3` | `bcms_opta_league_sync_total{action}` + 2 alert rule. Notification delivery 🔴 ayrı |
| schedule-list:2070 dead code | LOW-1 (overall ✅) | ✅ | `feed1d3` | Admin auto-augment satırı silindi |
| studio-plan canEdit signal | MED-005 (overall ✅) | ✅ | `feed1d3` | `_userGroups` signal pattern uygulandı |
| Schedules.id=32 deferral tracking | (Section 4) | 📝 | `9c8b690` | Section 4'e taşındı |

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
- ~~**4 dosya doc drift line ref'leri** (HIGH-002, kapatılmadıkça aynı)~~ → ✅ kapatıldı `90c8779`. Gelecek RBAC değişikliklerinde 6-pattern grep sweep tekrar çalıştırılır (Section 5 verify komutları)
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

# HIGH-002 RBAC drift sweep (6 pattern, 0 hit beklenir post-90c8779)
for p in "Admin/SystemEng" "Admin ve SystemEng" "SystemEng.*tam yetki" \
         "SystemEng.*tüm grup" "auto-augment yapıyor" '`Admin`.*`SystemEng`'; do
  echo "=== $p ==="
  grep -nE "$p" README.md ops/README.md ops/NOTES_FOR_CODEX.md || echo "no hits"
done

# Type-check
(cd apps/api && npx tsc --noEmit) && (cd apps/web && npx tsc --noEmit)

# OPTA P2002 retry pattern (kod-level kanıt)
grep -n "withLeagueCreateConflictRetry\|isLeagueCodeUniqueConflict" \
  apps/api/src/modules/opta/opta.sync.routes.ts

# OPTA observability metric + alerts (4e364f3)
curl -sf http://127.0.0.1:3000/metrics | grep "bcms_opta_league_sync_total"
curl -sf http://127.0.0.1:9090/api/v1/rules | grep -E "OptaLeague(Sync|Write)Burst"
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
| 6 | `bcms_grafana`, `bcms_prometheus` healthcheck eksik 🟡 partial | Up ama healthy değil; ek olarak `bcms_mailhog` da aynı durumda. **Design doc**: `ops/REQUIREMENTS-HEALTHCHECK.md` (`13ae22c`) — per-service health semantiği netleştirildi. Bulgular: (a) Prometheus + Grafana healthcheck eksik — **PR-1 ✅ kapatıldı** (`05fc592`): `wget --spider .../-/ready` (Prometheus) + `wget --spider .../api/health` (Grafana); verify snapshot'ında (`05fc592` push anı) ikisi de `(healthy)` — runtime'da değişebilir, Section 5 verify komutlarıyla canlı kontrol edilir; (b) `bcms_worker` `healthcheck: disable: true` (bilinçli karar, doc'la formalize edildi) — comment ekleme PR'ı bekliyor; (c) **yeni discovery — `bcms_opta_watcher` `pgrep -f` sahte process check kullanıyor**, "(healthy)" sinyali aldatıcı (SMB unmount / password expire'da yine pass). Design doc default önerisi: ya disable + dokümante, ya gerçek readiness check tasarlanana kadar mevcut sahte healthcheck'i kaldırma. Karar implementation PR'ında verilir, bu rapor pozisyon almaz. (b) + (c) "healthcheck semantics cleanup" başlığı altında ayrı PR olarak ele alınması öneriliyor. |
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
| 2026-05-01 | Critical review pass-3 + rewrite | 9 yeni hata + 5-bölümlü sadeleştirme | `469967f` |
| 2026-05-01 | RBAC doc final sweep | 6-pattern grep sweep (3 docs) | `90c8779` HIGH-002 ✅ |
| 2026-05-01 | OPTA observability detection | prom-client kontrollü geçişi + metric + 2 alert rule | `4e364f3` HIGH-003 detection ✅ |
| 2026-05-01 | State sync pass | Section 1/2/3 + Appendix D state güncelleme | `c6dace0` |
| 2026-05-02 | OPTA notification delivery design doc | Alertmanager + routing + secret yönetimi (4 alternatif) — decision-ready / implementation-scoped | `9be627a` |
| 2026-05-02 | Audit-traced maintenance pattern design doc | App-booted command + ALS context + metadata schema prerequisite — MED-001/MED-003/schedules.id=32 unblock'u | `cc6d688` |
| 2026-05-02 | Migration baseline-absent design doc | Measurement-first strategy selection (clean-room harness PR-1, A vs B prototype PR-2) — naive 8-dosya sahte güveni reddedildi | `2e2b6a4` |
| 2026-05-03 | Cross-ref state sync (4 design docs) | Section 2 her open risk'te design doc pointer + Appendix D Review History entries | `08802e4` |
| 2026-05-03 | Healthcheck design doc | Per-service health semantiği inventory + decision matrix; opta_watcher sahte `pgrep` healthcheck yeni discovery | `13ae22c` |
| 2026-05-03 | State sync (5th design doc + opta_watcher finding) | Appendix A #6 + closing italic update | `a6c9e67` |
| 2026-05-03 | PR-1 healthcheck implementation (Prom + Grafana) | tool verify (wget for both) + `/-/ready` + `/api/health` endpoints; ikisi de `(healthy)` verify snapshot'ında | `05fc592` |
| 2026-05-03 | State sync (PR-1 reflection) | Appendix A #6 status update — 🟡 partial + PR-1 closure notu + snapshot disclaimer | bu sürüm |

**Pass-3 kazanımı**: Spot-fix döngüsü (pass-1 + pass-2) raporu yamalı bir belgeye çevirmişti. Kritik hata olan "race condition note inline catch öneriyordu" pass-3'te yakalandı — outer retry canonical'i Section 2 HIGH-003'e geldi. Cleanup principle (data-write deferred until audit-traced path) Section 4'te tekleştirildi.

**Post-rewrite kazanımı**: Rapor patching döngüsünden gerçek iş yapma evresine geçildi. HIGH-002 ve HIGH-003 detection katmanı kapatıldı. Section 3 tablosu artık "component vs finding status" ayrımıyla — okur "HIGH-003 dedupe ✅" görüp tüm bulguyu kapatılmış sanmaz; bulgu overall status'u Section 1 sayım tablosunda ayrı tutuluyor.

---

*Bu rapor read-only audit ile başladı, iteratif kritik review'larla evrildi, pass-3'te 5-bölümlü yapıya yeniden yazıldı, sonraki turlarda RBAC doc sweep + OPTA observability detection ile açık riskler azaltıldı. Mevcut sürüm tek doğruluk kaynağı; eski detay/tarihsel narrative Appendix'lerde tutuldu. **Açık risklerin 4'ü için design doc + 1 hijyen design doc** tamamlandı (toplam 5: S3 backup, OPTA notification, maintenance pattern, migration baseline, per-service healthcheck) — hepsi decision-ready / implementation-scoped: implementation aşaması kullanıcı kararları, credential ve strateji onaylarına bağlı. Aksiyon kararları kullanıcıda.*
