# BCMS Read-Only Audit Report — 2026-05-01 (geç saat)

> **Mod**: İlk audit fazı read-only idi (hiçbir dosya/komut/DB değişikliği yapılmadı). Bu doküman sonradan iteratif olarak güncellendi — kapatılan bulgular işaretlendi, line ref'ler ve sayımlar tazelendi. Commit history'si aşağıdaki hash'lerde: `d074bcd` (initial), `5e3f238`, `feed1d3`, `05829f8`, `01dbe76`, `6d491e6`, `9b603f5`, `eac6454`, `9925422`, `73257b0`, `0d67c6e`, `9c8b690`.
> **Kapsam**: `apps/api/src` (46 dosya), `apps/web/src` (62 dosya), `packages/shared/src`, Prisma schema + migration'lar, canlı PostgreSQL/RabbitMQ/Keycloak/Docker, README/ops docs, son 30 commit.
> **Süre**: 12.5 dakika, 141 tool çağrısı (ilk audit).
> **Yöntem**: Statik kod analizi + canlı runtime doğrulama (psql SELECT, docker logs/ps, curl health, npx tsc --noEmit).
> **Status legend**: 🔴 açık · 🟡 partial · ✅ kapatıldı

---

## Triage Notu

İlk taslak agent raporu kullanıcı tarafından review edildi ve şu noktalar revize edildi:

| Eski (taslak) | Revize (final) |
|---|---|
| "CRITICAL 0" + "production-ready" | "0 code-critical + **1 OPS-CRITICAL aday** (off-host backup yok). Production-ready *host kaybı senaryosu hariç*." |
| Migration drift için (a)+(b) eşit ağırlık | Sadece **(a) — FS'e migration directory geri ekle**. (b) `_prisma_migrations` satır silme + DDL re-apply önerilmiyor — Prisma internal state'i bozar. |
| OPTA burst için "caller-bazlı rate limit ilk aksiyon" | Rate limit **son aksiyon**. Doğru sıra: (1) idempotent UPSERT audit dedupe → (2) observability/alert → (3) gerekirse limit. Trusted endpoint'te sert limit gerçek güncellemeleri kaçırır. |
| Soft-delete P2 | **P1** — semantic karar yokluğu yeni endpoint'lerde tutarsızlık üretir, borç büyür. |
| "4 katman Admin bypass tutarlı" | "Centralized bypass mekanizmaları çalışıyor; auto-augment kaldırıldı. UI'daki `schedule-list:2070` dead code da `feed1d3` ile ✅ temizlendi. PERMISSIONS convention'da kısmi tutarsızlık (LOW-2) duruyor." |

---

## 1. Executive Summary

| Severity | Count | Kapsam |
|---|---|---|
| 🔴 **CRITICAL (code)** | **0** | Auth bypass, secret leak, race kanıtı, production-stop sınıfı bulgu yok |
| 🟠 **OPS-CRITICAL aday** | **1** | Off-host backup yok — partial mitigation (local volume backup var, host failure'da kaybolur) |
| 🟠 **HIGH** | **3** (1 🟡 partial + 2 🔴) | Migration drift (FS-name 🟡 closed, baseline-absent 🔴); doc drift 🟡 partial; OPTA League upsert burst 🔴 |
| 🟡 **MEDIUM** | **4 🔴 + 1 ✅** | Soft-delete filter; redundant GiST; orphan ports; audit growth. ~~MED-005 canEdit reactive~~ ✅ kapatıldı (`feed1d3`) |
| 🟢 **LOW** | **3 🔴 + 1 ✅** | PERMISSIONS namespace; `as any` (audit plugin); console.* (kabul edilebilir). ~~LOW-1 auto-augment dead code~~ ✅ kapatıldı (`feed1d3`) |

**En yüksek 3 risk** (önceliklendirilmiş):
1. **Prisma migration drift** — DB'de 27 finished migration, FS'te 23 → 4 migration DB-only. DR/staging/CI senaryolarında kırılır.
2. **Off-host backup eksikliği (OPS-CRITICAL aday)** — `postgres_backup` sidecar local volume'da dump alıyor; disk/host arızası → backup da kaybolur. Yarım mitigation.
3. **Doc drift** — README + NOTES_FOR_CODEX RBAC ve migration count tutarsız. AI ajanları/yeni developer'lar için aktif yanlış-yönlendirme riski.

**Cross-cutting temalar**:
- **Doc-code drift**: 2026-05-01 RBAC refactor kod tarafında temiz; `feed1d3` ile docs'un büyük kısmı temizlendi ama bazı paragraflar (README:304, 343; ops/NOTES_FOR_CODEX.md:86; ops/README.md:154, 165) hâlâ eski "Admin → SystemEng auto-augment" modelinden kalıntı.
- **Soft-delete tutarsızlığı**: **21 tabloda** `deleted_at` kolonu var (live: `COUNT(DISTINCT) → 21`), sadece `shift_assignments` model'i için (`weekly-shift.routes.ts:144`) filter kullanılıyor. Diğer 20 tabloda kolon görmezden geliniyor.
- **Audit log büyüme dinamikleri**: 90-gün retention iyi tasarlanmış ama burst senaryolarında throttle/dedupe yok. 2026-04-30'da 9.5 saatlik (00:00–09:30) bir burst gerçekleşmiş — 205,022 satır (toplam audit_logs'un %36'sı), root cause unknown. **Update**: `0d67c6e` ile P2002 retry desenli idempotent dedupe kuruldu (HIGH-003 tarafı kısmen kapatıldı).
- **Race conditions kapatılmış**: DB-level GiST exclusion + P2002 catch ile defense-in-depth. Yapısal güvende.

**Sistem genel sağlığı**: **Production-ready** — *ancak host kaybı senaryosu hariç*. Kritik servisler healthy (api/web/postgres/keycloak/rabbitmq/postgres_backup/opta_watcher). `bcms_worker`, `bcms_grafana`, `bcms_prometheus`, `bcms_mailhog` container'ları "Up" ama healthcheck tanımsız (Section 8 #7). Type-check temiz, OPTA cascade ve recording port normalize sağlam, optimistic locking doğru uygulanmış. Kritik kod gap'i yok; HIGH bulgular operasyonel hijyen + doc kalitesi düzeyinde.

---

## 2. CRITICAL Bulgular

### Code-Critical: **YOK**

Hiçbir auth bypass, açık endpoint, secret leak, race condition kanıtı, veya production-stop sınıfı bulgu tespit edilmedi.

### OPS-Critical Aday — Off-host Backup Eksikliği

| | |
|:---|:---|
| **Durum** | Partial mitigation (yarım çözüm) |
| **Sebep** | `postgres_backup` sidecar (commit `5f6e728`) günlük 03:00'te local Docker volume'a pg_dump alıyor. Off-site/off-host kopya **yok**. |
| **Risk** | Disk arızası, host kaybı, ransomware, dosya sistemi corruption → hem production hem backup birlikte kaybolur. Son 1-7 gün arası tüm veri kayıp. |
| **Mevcut korumanın kapsamı** | ✅ Yanlışlıkla DROP TABLE / silme / mantıksal hata için 7-gün lookback OK ✅ DB corruption recovery için OK ❌ Disk/host failure için **KORUMA YOK** |
| **Önerilen** | rsync-to-remote-host veya S3 sync veya borgbackup ile günlük off-host kopya. `infra/postgres/RESTORE.md` zaten bu seçenekleri listeliyor — implementasyon yapılmamış. |
| **Severity rasyonalitesi** | "Tam OPS-CRITICAL" (no backup at all) değil çünkü backup VAR. "Tam OK" (off-site verified) da değil çünkü kapsam dar. **Aday** sınıfı: yarım mitigation, blast radius geniş ama mitigation tamamlanırsa CRITICAL'dan düşer. |

---

## 3. HIGH Bulgular

### HIGH-001 — Prisma migration baseline drift: standalone replay imkansız

**Status (2026-05-01 geç saat — commit `05829f8` + `01dbe76` + clean-room verify)**: 🟠 **DEEPER PROBLEM REVEALED**

İlk taslak audit "drift" demişti; clean-room replay ile gerçek karakter ortaya çıktı: **bu pure drift değil, baseline absent.**

**Clean-room replay sonucu (2026-05-01)**:
```
Clean PG container yarat → btree_gist extension MANUEL inject → migrate deploy
Result: FAIL on first migration (20260416000000_add_matches)
Error: relation "schedules" does not exist
```

⚠️ **Test kalitesi notu**: `btree_gist` extension migration içinde değil, manuel olarak clean PG container'a inject edildi. Eğer fresh replay gerçekten standalone desteklenecekse, extension `CREATE EXTENSION IF NOT EXISTS btree_gist` adımı bir migration içinde olmalı. Manuel injection testi zayıflatıyor — gerçek fresh env'de extension yok varsayımıyla replay denenmeli.

**Açıklama**: 
- 27 FS / 27 DB sembolik eşleşmesi tam (commit `05829f8` sonrası)
- ❗ Ama `add_matches` migration'ı `schedules`/`bookings`/`leagues` tablolarına ALTER yapıyor — baseline'da yaratılmış olmaları gerekir
- `ops/NOTES_FOR_CODEX.md` içinde belirtildiği gibi: "Local DB 2026-04-22'de 8 migration baseline edildi" — bu baseline'ın **gerçek DDL'i FS'te yok**
- DB en eski migration entry'si `20260420000000_schedule_finished_at_and_timestamps` (2026-04-22 uygulanmış); bundan önceki migration'lar baseline'a dahil
- FS'teki tüm migration'lar **baseline-dependent**, standalone replay edilemez

**Gerçek etki matrisi**:

| Senaryo | Etki |
|---|---|
| Mevcut prod çalışıyor mu? | ✅ Evet (DDL'ler zaten DB'de) |
| Postgres backup → restore (DR) | 🟡 Code-level safe (pg_dump full schema içerir, replay gerekmez) — **DR güvencesi ancak off-host kopya + restore drill ile söylenebilir**. Local volume'daki backup host kaybında prod'la birlikte gider. Off-host yokken "DR safe" denmez. |
| CI/CD clean-DB build | ❌ Kırılır (replay fail) |
| Yeni dev env "fresh setup" | ❌ Kırılır (replay fail) |
| Staging environment provisioning | ❌ Kırılır |

**Doğru çözüm yönü (ayrı design + clean-room kanıt PR'ı gerektirir — bu rapor sadece problem tanımı)**:

⚠️ Aşağıdaki adım listesi **reçete değil yön**. Naive uygulama (örn. `pg_dump --schema-only` → `000_baseline`) clean-room replay'de duplicate constraint / index / sequence hataları üretir, çünkü mevcut FS migration'ları aynı tabloları yeniden ALTER ediyor. Doğru çözüm:

1. Production'dan schema dump alma stratejisi (hangi flag'ler, hangi sıra) **clean-room PG'de fiilen test edilmeli**
2. Mevcut 27 FS migration'ından hangileri archive'a taşınacak, hangileri baseline ile çakışmayan increment olarak kalacak — dosya bazında karar
3. `_prisma_migrations` tablosu re-init stratejisi prod'a dokunur — staging'de tam dry-run gerekir
4. Tüm akış clean-room'da **ucundan ucuna replay başarılı** kanıtlanmadan prod'a uygulanmaz

Bu iş **ayrı bir tasarım dokümanı + ayrı PR** olarak ele alınmalı, mevcut audit fix akışına dahil edilmemeli.

**Geçici durum**: 
- DR güvencesi off-host backup + restore drill ile sağlanmalı (OPS-CRITICAL aday — yukarı bakın)
- CI/CD ve fresh dev env için workaround: `pg_dump --schema-only` çıktısını `seed.sql` olarak elden uygulanabilir, ama bu **kalıcı çözüm değil**.

**Eski "PARTIAL FIX" notları (commit `05829f8`)**:
- ✅ FS klasör adları `_prisma_migrations` satırlarıyla eşleşti (4 yeni directory)
- ✅ `prisma migrate deploy` checksum mismatch atmıyor (mevcut prod'da)
- ✅ `shift_assignments` için gerçek DDL (replay'de o adımdan sonra çalışır eğer baseline varsa)
- ⚠️ 3 migration placeholder **no-op** — bu dosyalar `SELECT 1;` içerir, **gerçek schema değişikliklerini içermez**. Sadece `_prisma_migrations` tablosundaki "applied" kayıtları için bookkeeping placeholder'dır. **Yeni env provisioning için GÜVENİLMEZ**: replay edildiğinde DDL uygulanmaz, sadece migration entry'si işaretlenir. Fresh DB kurulumunda eksik index/constraint/cascade ile kalırsınız. Sadece mevcut prod DB'de Prisma'nın "schema in sync" demesi için var.
- ❌ Replay equivalence: **standalone replay imkansız** (baseline absent)

**Lokasyon**: `apps/api/prisma/migrations/` ve `_prisma_migrations` tablosu

✅ **FS-name drift bölümü `05829f8` ile kapatıldı** (live verify: FS 27 = DB 27). Aşağıdaki orijinal kanıt + (a)/(b) reçetesi tarihsel kayıt için tutuldu — **canonical guidance yukarıda (line 102-115)**, "ayrı tasarım dokümanı + ayrı PR" yaklaşımı geçerli. Asıl açık problem **baseline-absent** (replay equivalence), bu farklı bir konu.

<details>
<summary>📜 Eski snapshot — FS-name drift (kapatıldı `05829f8`)</summary>

**Eski kanıt** (commit `05829f8` öncesi, şu an stale):
- DB'de 27 finished migration, FS'te 23 (eski sayım — şu an FS de 27)
- DB-only listesi: `20260427000000_add_shift_assignments`, `20260427003000_fix_indexes_and_cleanup`, `20260427160000_add_fks_indexes_cascade_timestamptz`, `20260428000000_manual_schema_sync` (hepsi şimdi FS'te)

**Eski "Önerilen düzeltme — sadece (a)"** (sadece FS-name drift için, replay equivalence kapsamı dışında):
1. `prisma migrate status` ile drift'i net tanımla
2. DB'deki 4 migration için DDL reverse-engineer
3. Repoya migration directory ekle
4. `_prisma_migrations` zaten "applied" → idempotent

**(b) yolu önerilmedi**: `_prisma_migrations`'tan satır silme + re-apply Prisma internal state'ini bozar.

✅ Adımlar `05829f8` ile uygulandı; FS-name drift kapatıldı. Replay equivalence ayrı problem.

</details>

---

### HIGH-002 — Doc drift: README + NOTES_FOR_CODEX RBAC kalıntıları 🟡 partial

**Status (2026-05-01 geç saat — `feed1d3` sonrası live re-verify)**: 🟡 **Partial fix**. `feed1d3` doc drift'in büyük kısmını kapattı; kalan kalıntılar aşağıda. **Orijinal raporun line ref'leri post-`feed1d3` kaymış**, aşağıdaki liste güncel grep sonuçları.

**Kalan gerçek drift** (live grep, 2026-05-01 son verify):
```
README.md:304   "auth.ts plugin Admin token'ında SystemEng auto-augment yapıyor"
              ❌ Şu anki zaman, yanlış. Kaldırıldı (`0220b3e`); auth.ts:101 sadece comment.

README.md:343   "StudyoSefi, SystemEng ve Admin tam yetkili"
              ❌ Eski wording. rbac.ts'e göre reports.{read,export} = ['Admin'] only.

ops/NOTES_FOR_CODEX.md:86  "Admin ve SystemEng sistem genelinde tam yetkili kabul edilir."
              ❌ Yanlış. Sadece Admin tam yetkili (`b3171d9` + `0220b3e`).

ops/README.md:154, 165  "Admin/SystemEng tüm gruplarda tam yetkilidir"
              ❌ Eski wording.
```

**`feed1d3` ile zaten kapatılan / doğru olan paragraflar** (orijinal raporun bahsettiği ama düzeltilmiş yerler):
- `README.md:5, 274, 307` → yeni doğru içerik
- `ops/NOTES_FOR_CODEX.md:103` → "auto-augment **kaldırıldı**" (doğru)
- `ops/README.md:3, 411` → yeni doğru içerik

**Açıklama**: 2026-05-01 RBAC refactor sırasında kod doğru yazıldı; `feed1d3` ile docs paragraflarının çoğu güncellendi ama 4 dosyada toplam ~5-6 paragraf hâlâ eski wording'i içeriyor.

**Etki**: 
- AI ajanları (Codex/Claude) doc'tan PERMISSIONS okursa SystemEng'e yanlış yetki ekleyebilir
- Yeni gelen developer eski paragrafa inanırsa yanlış mental model edinir
- 21-migration claim'i operasyon sırasında "şüpheli durum" yaratır (gerçekten ne var, ne yok)

**Önerilen düzeltme**:
1. README + ops/README + NOTES_FOR_CODEX'te eski "Admin → SystemEng auto-augment" referanslarını sil
2. "Admin/SystemEng tüm grupları görür" → "Admin tüm grupları görür; SystemEng kendi grubu" düzelt
3. Migration count'u canonical sayıya update et (FS sayısı + DB drift notu HIGH-001 çözülene kadar)
4. NOTES_FOR_CODEX'te PERMISSIONS matrisini tekrar etmek yerine `packages/shared/src/types/rbac.ts`'yi canonical kaynak olarak işaret et — drift kaynağını ortadan kaldır

**Doğrulama**: Doc'taki yetki tablosu ve `rbac.ts` PERMISSIONS array'leri diff'lenince fark çıkmamalı. `ls apps/api/prisma/migrations/ | wc -l` ile doc'taki sayı eşit olmalı.

---

### HIGH-003 — OPTA League upsert burst (2026-04-30 00:00–09:30): audit_logs %36'sı, burst içinde League %99.99

**Lokasyon**: `apps/api/src/modules/opta/opta.sync.routes.ts` (kod kendisi sağlam — burst kaynağı sync caller / Python watcher davranışı)

**Kanıt** (doğrulanmış live psql, 2026-05-01 geç saat):
```
audit_logs durumu:
  total:    565,032
  son 24h:  297,541 (toplam ~%53)
  son 7d:   564,907
  size:     104 MB

Burst pencere sayım (2026-04-30 00:00–09:30):
  burst_window:  205,022 satır  (toplam audit_logs'un %36.29'u)
  burst_league:  205,021 satır  (burst içinde League %99.99 — neredeyse tamamı)

Saatlik breakdown (2026-04-30):
  hour                    total   League
  00:00              ──── 31,744  31,744  ┐
  01:00              ──── 31,744  31,744  │
  02:00              ──── 31,744  31,744  │ Sabit ritim
  03:00              ──── 31,744  31,744  │ ~31k/saat = ~528/dakika = ~8.8/saniye
  04:00              ──── 32,256  32,256  │
  05:00              ──── 31,777  31,776  │
  06:00              ──── 31,806  31,806  │
  07:00              ──── 31,806  31,806  │
  08:00              ──── 31,275  31,275  │
  09:00              ──── 24,759  24,759  ┘ (azalmaya başlıyor)
  10:00                       4       4   ┐
  11:00                       8       7   │ Normal seviyeye dönüş
  12:00–23:00            ~5–84   varies   ┘ (saatte birkaç-onlarca)
```

**Açıklama**: 
- Burst gerçekte **00:00'dan 09:30'a** kadar devam etti (~9.5 saat, agent ilk taslakta 03-09 dedi — saatlik breakdown başlangıç saati daha erken).
- OPTA Python watcher (`scripts/opta_smb_watcher.py`) `DEFAULT_INTERVAL=3600` (saatte 1 sync) ile çalışıyor. Burst sırasında saatte 31,744 upsert sabit ritim → 528/dakika = 8.8/saniye → saatlik sync ritmi ile **kesinlikle uyumsuz**.
- Burst İÇİNDE League ratio **%99.99** (205,021 / 205,022) — yani burst tamamen League upsert'lerden oluşuyor.
- Total audit_logs'a göre payı **%36.29** — tüm log'un üçte birinden fazlası.
- **API log retention olmadığı için root cause analizi imkansız** — eski API log'ları erişilebilir değil, hangi caller bu kadar sürekli sync POST attı bilinmiyor.
- Şu anda ritim normale dönmüş (saatte 4-84 League upsert, tipik OPTA polling).

**Etki**:
- Doğrudan zarar yok — audit purge job 90 gün sonra temizleyecek; disk'te 104 MB
- Aynı pattern tekrar yaşanırsa 90 günde milyonluk satır → retention job batch'leri lock pressure üretir
- `/opta/sync` `rateLimit: false` → caller saatlerce dakikada 8 POST'a çıkabilir, kimse müdahale edemez
- Olayın **nedeni bilinmediği** için tekrar yaşanma riski var

**Önerilen düzeltme** — doğru sıra:
1. **Idempotent UPSERT audit dedupe** (kök neden): League upsert'te eski + yeni değer aynıysa Prisma audit hook satır yazmasın. Mevcut audit plugin (`audit.ts:75, 97`) her upsert çağrısını ayrı satıra yazıyor; idempotent durumlarda gereksiz yazım.
2. **Observability + alert** (görünürlük): Prometheus metric ekle — `opta_sync_league_upserts_total` ve saatlik diff. Alert: saatlik delta > N geçerse Slack/email.
3. **Caller-bazlı rate limit** (son seçenek, dikkatli): Yalnızca (1) ve (2) yetersiz kalırsa. Bearer token veya x-real-ip ile keylenen sınır. Sıkı limit gerçek güncellemeleri kaçırma riski taşıdığı için yumuşak başlanmalı (warn-only ilk hafta).

⚠️ **Race condition notu (dedupe implementasyonu için)** — commit `a0946c4` `findMany` → `create`/`update` deseni kullanıyor (upsert yerine, audit dedupe için). Bu desen concurrent OPTA sync'lerde race açar:
- T1: `findMany` → `code` kaydını bulmaz → `create` çağıracak
- T2: aynı anda `findMany` → bulmaz → `create` çağıracak
- T1 commit eder, T2 unique constraint hata atar → P2002

Çözüm: `create` çağrısını `try/catch` ile sar, P2002 yakalanırsa `findUniqueOrThrow` yapıp `leagueMap.set(compId, existing.id)` ile haritayı doldur. Aksi halde sonraki match.create'lerde `leagueId` undefined kalır → cascade hata. Bu retry pattern dedupe PR'ının zorunlu parçasıdır.

**API log retention öneri**: Loki/Promtail veya docker logging driver (json-file rotation) — gelecek burst'leri post-mortem yapabilmek için.

**Doğrulama**: Aynı sync 100 kez ardışık çağrıldığında League satırları için audit_logs sayısı ilk sync'ten sonra sabit kalmalı (0 yeni satır).

---

## 4. MEDIUM Bulgular

### MED-001 — Soft-delete filter eksik (P1, kapsam genişleme riski)

**Status (2026-05-01 geç saat — Adım 3 inventory tamamlandı)**: 🔍 **Inventory net, hard delete kararı netleşti**

**Inventory sonuçları (live psql + grep)**:

**A. DB tarafı — 21 tablo `deleted_at` kolonuna sahip**:
```
audit_logs, bookings, broadcast_types, channels, incidents, ingest_jobs,
ingest_plan_items, leagues, matches, qc_reports, recording_ports,
schedules, shift_assignments, signal_telemetry, studio_plan_colors,
studio_plan_programs, studio_plan_slots, studio_plans, teams,
timeline_events, workspaces
```

**B. Veri durumu**:
```
TÜM TABLOLARDA SOFT-DELETED SATIR SAYISI: 1
  schedules: id=32 ("Manchester United - Brentford", 2026-04-28 09:13:50.141)
DİĞER 20 TABLO: 0 soft-deleted satır
```

**C. Kod kullanımı — sadece 1 yer aktif kullanıyor**:
```
[Backend]
apps/api/src/modules/weekly-shifts/weekly-shift.routes.ts:144
  where: { weekStart, deletedAt: null }
  ↑ Tek aktif soft-delete pattern. Bu tablo (shift_assignments) Prisma
  schema'da deletedAt camelCase (diğer 19 tablo snake_case deleted_at).

[Frontend]
Hiç referans yok.

[Prisma schema'da]
21 tabloda deleted_at field tanımlı (default Prisma naming) — ama
sadece ShiftAssignment model'inde @map("deleted_at") + camelCase
deletedAt kullanılıyor.
```

**Kapsam revizyonu**: 21 tabloda kolon DROP işlemi başlangıçta "30 dk hard delete" olarak değerlendirildi — yanlış değerlendirme. Doğru kapsam:

⚠️ **Bu schema redesign seviyesinde iş** — küçük bir migration değil. Kontrol edilmesi gerekenler:
- Prisma schema 21 model field değişikliği
- Raw SQL SELECT'ler (raporlar, audit serializer, import/export)
- Mevcut indexes ve partial unique constraints (`deleted_at IS NULL` partial index var mı?)
- FK behavior — soft-delete'i CASCADE/RESTRICT bağlamında etkileyen bir yer var mı?
- Audit serializer (`audit.ts`) deletedAt field'ı how serializing
- 21 tabloda fiili soft-deleted satır SADECE 1 (schedules.id=32) — 20 tablo zaten boş, ama kolonlar drop edilince schema migration replay edilince eski snapshot'larla uyumsuzluk

**Bu yüzden öneri**: 
1. **Önce mini-karar**: `schedules.id=32` restore mi hard delete mi? (ayrı kullanıcı kararı, izole iş)
2. **Sonra ayrı PR** olarak schema redesign — kapsam geniş, hızlı PR olarak yapılmaz, ayrı tasarım + review + staging'de test gerektirir
3. `weekly-shifts/weekly-shift.routes.ts:144` filter kaldırma — bu adım da schema redesign PR'ında, izole değil

**Eski tahmin yanlış**: "P1, 2-3 saat" → Gerçek: **schema redesign, ayrı PR, kapsam geniş**.

⚠️ **Bu adım prod DB'ye dokunur** — kullanıcı onayı bekleniyor.

**Eski lokasyon**: 
- `apps/api/src/modules/schedules/schedule.service.ts:48-86, :88-99`
- (Ayrıca: bookings, incidents, studio_plan_*, audit_logs — kolonlar var, filter yok)

**Kanıt**:
```
psql: SELECT id, deleted_at FROM schedules WHERE deleted_at IS NOT NULL
  → 1 row (id=32, "Manchester United - Brentford", deleted_at='2026-04-28 09:13:50.141')

grep -n "deletedAt\|deleted_at" apps/api/src
  → sadece weekly-shifts/weekly-shift.routes.ts:144 filtre kullanıyor
  → schedule queries: hiç filter yok
```

**Açıklama**: `schedules` tablosunda `deleted_at` kolonu var ve 1 row dolu. `findAll`/`findById` filter koymuyor → soft-deleted satır listede görünür. `remove()` ise hard `prisma.schedule.delete()` yapıyor → soft-delete'i kim/nasıl koydu belirsiz (manuel SQL? eski code path?).

**Etki**: Şu an 1 satır görünür, etki minimal. Ama **net karar yokluğu** developer her yeni endpoint'te aynı soruyla karşılaşıyor — soft-delete-aware mı, değil mi? Tutarsızlık tüm projeye yayılır.

**Severity revision**: P2 yerine **P1** — kullanıcı feedback'i: "1 satır küçük görünebilir ama semantic karar net değilse büyür."

**Öneri**: İki seçenekten birini net seç:
- (a) **Hard delete only**: tüm soft-delete kolonları drop (migration), `delete()` zaten hard çalışıyor
- (b) **Universal soft-delete**: tüm modüllerde `findAll`/`findById` query'lerine `deletedAt: null` filter, ayrıca `restore()` endpoint'i

---

### MED-002 — `schedules` üzerinde 2 redundant GiST exclusion

**Lokasyon**: Migrations `20260427160000_add_fks_indexes_cascade_timestamptz` ve `20260429020000_integrity_constraints`

**Kanıt** (`\d schedules`):
```
"schedules_no_channel_time_overlap"  EXCLUDE USING gist
   (channel_id WITH =, tstzrange(start_time, end_time, '[)'::text) WITH &&)
   WHERE (channel_id IS NOT NULL AND status <> 'CANCELLED'::schedule_status)

"schedules_no_overlap"  EXCLUDE USING gist
   (channel_id WITH =, tstzrange(start_time, end_time) WITH &&)
   WHERE (status <> 'CANCELLED'::schedule_status)
```

**Açıklama**: İki constraint çakışıyor — `channel_id IS NULL` durumunda her ikisi de NULL'ı "not equal" sayar (GiST default), `[)` vs `()` range sınırı küçük fark ama overlap testi açısından çoğu zaman aynı sonuç. Üst üste tutmak: insert/update başına iki kez index kontrolü → ekstra DB CPU.

**Öneri**: 
1. Migration definition'larını ve order'ı verify et (HIGH-001 drift'i ile birleşir — bu migration DB-only listesinde)
2. **`[)` semantik daha sağlam** olduğu için `_no_channel_time_overlap` kalsın, eski `_no_overlap` drop edilsin
3. **DİKKAT**: drop sırasında definition + migration order kontrolü — sadece isimden karar değil

**Risk**: HIGH-001 ile bağlı — migration drift çözülmeden bu drop migration'ı eklemek state'i daha karışık hale getirir.

---

### MED-003 — 3 ingest_plan_items satırı port atamasız

**Status (2026-05-01 geç saat — Adım 6a bağlantı kontrolü tamam)**: 🟢 **Tamamen orphan — silmek güvenli**

**3 orphan satır detay**:
| id | gün | saat | tip | not | yaratılış |
|---|---|---|---|---|---|
| 54 | 2026-04-25 | 13:30-15:30 | manual | - | 02:18:28 |
| 107 | 2026-04-26 | 14:30-16:30 | ingest-plan | yedek | 21:50:07.067 |
| 108 | 2026-04-26 | 14:30-16:30 | ingest-plan | - | 21:50:07.907 |

**Bağlantı kontrolü (live psql, 0 hit her tabloda)**:
- `ingest_jobs.job_id` → 0 satır (job_id zaten NULL)
- `qc_reports` → 0 satır
- `incidents.metadata.sourceKey` → 0 satır
- `ingest_plan_item_ports` → 0 satır

**Açıklama**: 107 ve 108 aynı gün/saat 840ms farkla yaratılmış; muhtemelen UI'da double-click veya eski "yedek" pattern artığı. 54 tek başına manual entry. Hiçbir downstream sistem bu satırlara referans vermiyor.

**Adım 6b için karar**: Cascade etki yok, hard delete güvenli. ⚠️ **Prod DB'ye dokunur — kullanıcı onayı bekleniyor.**

**Eski lokasyon**: DB veri kalıntısı (recording_port normalize migration sonrası)

---

### MED-004 — `audit_logs` büyüme trendi

**Lokasyon**: `apps/api/src/modules/audit/audit-retention.job.ts`

**Kanıt**:
- 565,032 satır = 104 MB; son 24h içinde 297,541 eklendi (büyük çoğunluğu 2026-04-30 00:00–09:30 burst penceresinden — HIGH-003)
- Normal günlük büyüme tahmini: ~5k satır
- 90 × 5000 = 450k normal; bursts olursa milyonluk
- Retention job 10k batch sıralı; 28M satır = 2800 batch × ~50 ms = 140 saniye lock pressure

**Öneri** (uzun-vadeli): 
1. Monthly partitioning (`audit_logs_p202604`, ...) — drop partition O(1)
2. Retention job'a anomali tespiti (bir seferde 100k+ silinmesi gerekirse Prometheus alert)
3. HIGH-003 idempotent dedupe çözülürse sorunun büyük kısmı kapanır

---

### MED-005 — `studio-plan.component.ts canEdit` reactive değil ✅ KAPATILDI

**Status**: ✅ **Kapatıldı (`feed1d3`)**.

**Çözüm uygulandı** (live verify):
- `studio-plan.component.ts:139` → `private readonly _userGroups = signal<string[]>([]);`
- `studio-plan.component.ts:141` → `canEdit = computed(() => { const userGroups = this._userGroups(); ... });` (signal-reactive)
- `studio-plan.component.ts:226` → ngOnInit içinde `this._userGroups.set(parsed?.groups ?? []);`

`app.component.ts` pattern'iyle uyumlu hâle getirildi. Token refresh + signal güncellemesi sonrasında `canEdit()` doğru re-evaluate olur.

**Eski açıklama** (tarihsel kayıt): `tokenParsed` Keycloak instance'ından okunduğu için `computed()` reactive izleyemiyordu; risk pratikte minimaldi (token refresh'te groups claim'i değişmez), düzeltme defensive idi.

---

## 5. LOW / Cosmetic

### LOW-1 — `schedule-list.component.ts:2070` Admin auto-augment dead code ✅ KAPATILDI

**Status**: ✅ **Kapatıldı (`feed1d3`)**.

**Çözüm uygulandı** (live verify): Mevcut kodda `schedule-list.component.ts:2073` → `this._userGroups.set(groups);` (temiz). Admin → SystemEng augment satırları silindi. `hasGroup()` helper (line 36-39) Admin short-circuit'ı zaten yetkiyi karşılıyor; augment hiçbir davranış kazandırmıyordu, dead code temizlendi.

**Eski kanıt** (tarihsel kayıt — `feed1d3` öncesi):
```ts
// schedule-list.component.ts:2070 (eski):
this._userGroups.set(
  groups.includes(GROUP.Admin)
    ? Array.from(new Set([...groups, GROUP.SystemEng]))
    : groups
);
```

### LOW-2 — `users.routes.ts` PERMISSIONS namespace overload

**Kanıt**: `apps/api/src/modules/users/users.routes.ts:107, 142, 148, 176, 231, 247` — User CRUD endpoint'leri `PERMISSIONS.auditLogs.read` kullanıyor

**Öneri**: Yeni `PERMISSIONS.users.{read,write,delete}` namespace ekle. Sadece kozmetik — semantik adlandırma temizliği.

### LOW-3 — `audit.ts` 4 adet `as any`

**Kanıt**: `apps/api/src/plugins/audit.ts:75, 77, 97, 147`

**Açıklama**: Prisma `$extends` runtime API'sinin tipi reduce edilmiş; generic tipleme sınırı. Custom type helper ile bypass edilebilir ama ek bakım maliyeti getirir. Kabul edilebilir tech debt.

### LOW-4 — `console.*` 4 yer (kabul edilebilir)

**Kanıt**: `apps/web/src/main.ts:5` + `apps/web/src/app/core/services/logger.service.ts:31-33`

**Açıklama**: Hepsi LoggerService kanalı veya bootstrap fallback. Beklenen seviye, kabul edilebilir.

---

## 6. False Positives Önlendi

Bug gibi görünen ama olmayanlar — gelecekteki audit'lerin tekrar tuzağa düşmemesi için belgelendi:

- **`ScheduleService.update` outside-transaction version check**: `findById`'de version'a bakıp 412 atıyor, ardından `tx.updateMany({ where: { id, version } })` ile gerçek lock — ikinci aşama race-safe. Sadece hız iyileştirmesi, bug değil.

- **`audit.ts` worker context'te phantom audit yazımı**: ALS store yoksa anlık `base.auditLog.createMany`, transaction rollback → audit kalır. Mevcut worker'lar atomic single-step yazıyor; transaction içinde failed write zaten en altta `try/catch` ile recoverable. Risk var ama somut bug üretmedi.

- **`config.ts:41 setInterval` SPA bootstrap'ta clear edilmiyor**: SPA root'ta token refresh için 60sn interval. Browser sekmesi kapanınca GC. Önceki audit'lerde "memory leak" denmişti — yanlış. Severity yok.

- **MatDialog `afterClosed()` ve MatSnackBar `onAction()` subscribe'lar**: complete-once observable'lar; auto-teardown var. Önceki audit'te yanlışlıkla CRITICAL listelendi, tekrar etmedim.

- **RabbitMQ reconnect window race**: connection drop → close handler → 5sn sonra reconnect → consumers re-register var. Ufak window var ama optional/dev mode'da fallback null-publisher. Production'da `RABBITMQ_OPTIONAL=false` zaten throw eder.

- **`/metrics` endpoint auth'sız**: production'da nginx-arkasında, dış dünya görmüyor. Internal Prometheus pull pattern. Severity yok.

- **`opta-watcher` Node service kalıntısı**: `app.ts:122` `run('opta-watcher', startOptaWatcher)` çağrılıyor ama worker container env'i `BCMS_BACKGROUND_SERVICES`'te listelenmemiş. Worker logs'ta `service:"opta-watcher" msg:"Background service disabled"` doğrulandı. Eski Node OPTA watcher kodu hâlâ dur ama config doğru. Severity yok.

---

## 7. Doc Drift Detail

(HIGH-002'de ana liste; bu bölüm ek nüans:)

**Aynı dosya içinde yeni-eski karışım**:
- `README.md` satır 254 (eski) ve 266 (yeni) ardışık duruyor — okuyucu hangisi canonical bilemez
- `ops/NOTES_FOR_CODEX.md` satır 97-110 (eski tablo) ve 196 (yeni RBAC bölümü) çelişiyor

**AI agent risk faktörü**: Codex/Claude ajanları doc okuyup PERMISSIONS refactor'ü yaparlarsa eski paragrafa inanma riski var. NOTES_FOR_CODEX özellikle "Codex için yazılmış" — drift bu dosyada en kritik.

**Çözüm**: Single source of truth principle — PERMISSIONS matrisini doc'ta tekrar etmek yerine `rbac.ts` dosyasına işaret et. Doc drift kaynağı kapanır.

---

## 8. Açık Follow-up'lar (commit mesajlarından)

Pending iş listesi (gerçekleştirilmemiş, sadece commit notlarında işaretlenmiş):

1. **OPTA drift scan PR** — `0ed06f9` ve `5ee459b` mesajları: `metadata.optaAppliedMatchDate` field + her sync'te tarama job'u atomik introduction
2. **Off-host backup copy** — bu raporda OPS-CRITICAL aday olarak ayrı kategoride
3. **Backup compression fix** — image v0.0.11 quirk
4. **Tekyon /channels permission UX** — Tekyon kanal seçemeyince 403, ya read-only public endpoint ya yetki ekleme
5. **Channel-overlap cascade conflict resolution UX** — OPTA cascade conflict yaşadığında kullanıcıya UI'da gösterme
6. **Architecture decoupling** — OPTA ingest vs cascade ayrıştırması
7. **`bcms_grafana` ve `bcms_prometheus` healthcheck eksik** — Up ama healthy değil
8. **2026-04-30 burst post-mortem** (HIGH-003) — log retention yok, gelecek anomaliler kayıp
9. **`schedules.id=32` kalıntı kayıt** — DRAFT, channel/match FK/booking boş, deleted_at dolu ama live-plan query'lerinde görünür. Düşük risk. Audit-traced maintenance pattern netleşmeden yazma yapılmayacak; MED-001 soft-delete strategy PR'ında ele alınacak.

---

## 9. Verification Commands Used

```bash
# Repo & status
git log --oneline -30
git status --short
ls apps/api/prisma/migrations/

# Containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
docker stats --no-stream
docker logs --tail 30 bcms_postgres_backup
docker logs --tail 30 bcms_opta_watcher
docker logs --tail 50 bcms_api
docker logs --tail 50 bcms_worker

# Health
curl -sf http://127.0.0.1:3000/health

# Code patterns
grep -rn "SystemEng" apps/web/src apps/api/src packages/shared/src
grep -rn "as any" apps/web/src apps/api/src packages/shared/src
grep -rn "console\." apps/web/src
grep -rn "rabbitmq.publish" apps/api/src
grep -rn "preHandler" apps/api/src/modules/*/*.routes.ts
grep -rn "TODO\|FIXME" apps/api/src apps/web/src packages/shared/src

# Type check
cd apps/api && npx tsc --noEmit  # exit 0
cd apps/web && npx tsc --noEmit  # exit 0

# DB (read-only SELECT)
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "..."
  - _prisma_migrations COUNT + SELECT
  - pg_stat_user_tables
  - audit_logs trend (24h, 7d, total, hourly breakdown)
  - schedules.deleted_at filter check
  - ingest_plan_items, ingest_plan_item_ports orphan check
  - schedules metadata.optaMatchId / optaAppliedMatchDate / liveDetails.recordLocation
  - GiST exclusion / FK check via \d
```

---

## 10. Sonuç & Öncelik Planı

### Sistem güçlü olduğu yerler

- **Backend mimari sağlam**: Prisma audit extension `als` ile request-bağlamlı, phantom write koruması var; optimistic locking pattern Schedule + Booking için doğru uygulanmış (TOCTOU yok); RabbitMQ ConfirmChannel ile silent drop kapatılmış; SERIALIZABLE retry pattern doğru.
- **Auth**: Centralized bypass mekanizmaları çalışıyor — `requireGroup` `isAdminPrincipal` + `AuthGuard` + `visibleNavItems` filter + `hasGroup()` helper. `requireGroup` her route'ta uygun. `SKIP_AUTH` production'da iki yerde block edilmiş.
- **Type-check**: API + Web tertemiz (tsc --noEmit exit 0).
- **Docker compose**: tüm servisler healthy, port bindings güvenli (sadece web/Keycloak public, gerisi 127.0.0.1).
- **Postgres backup**: çalışıyor, rotation aktif (off-host kopya hariç). `infra/postgres/RESTORE.md` runbook olarak dokümante edilmiş; **fiili drill execution kanıtı bu audit kapsamında bulunmadı** — drill yapılmış mı belirsiz.

### Sistem zayıf olduğu yerler

- **Doc drift** 🟡 partial — `feed1d3` çoğunu kapattı, 4 dosyada hâlâ eski wording (HIGH-002 yenilenmiş line listesi)
- **Migration baseline-absent** 🔴 — FS-name drift kapatıldı; standalone replay imkansız (DR/CI senaryolarında)
- **Off-host backup yok** 🔴 — host failure → tüm veri kayıp
- **Audit log inflation potansiyeli** 🟡 — `0d67c6e` ile dedupe kuruldu, observability/alert eksik
- **Soft-delete tutarsızlığı** 🔴 — schema redesign kapsamı, ayrı PR (MED-001)
- **Restore drill kanıtsız** 🔴 — runbook var, fiili execution kanıtlanmadı

### Önceliklendirilmiş Aksiyon Planı

| Öncelik | Aksiyon | Status |
|---|---|---|
| ~~P0~~ | ~~HIGH-001: FS-name drift~~ | ✅ `05829f8` |
| **P0** 🔴 | HIGH-001: Baseline-absent — ayrı tasarım dokümanı + clean-room kanıt PR | open, ayrı PR |
| **P0** 🟡 | HIGH-002: Kalan 4 dosya doc drift (README:304/343, NOTES_FOR_CODEX:86, ops/README:154/165) | partial, ~15 dk |
| **P0** 🔴 | OPS-CRITICAL aday: Off-host backup (S3-compatible PR `9925422` requirements) | open, credential bekliyor |
| **P1** 🟡 | HIGH-003: League dedupe (`a0946c4`) + P2002 retry (`0d67c6e`) | partial, observability eksik |
| **P1** 🔴 | HIGH-003 observability: Prometheus opta_sync metrics + alert | open, 1-2 saat |
| **P1** 🔴 | MED-001: Soft-delete schema redesign — ayrı PR (geniş kapsam) | open |
| ~~P1~~ | ~~LOW-1: schedule-list:2070 dead code~~ | ✅ `feed1d3` |
| ~~P1~~ | ~~MED-005: studio-plan canEdit signal pattern~~ | ✅ `feed1d3` |
| **P2** 🔴 | MED-002: Redundant GiST drop migration (baseline-absent sonrası) | open |
| **P2** 🔴 | MED-003: 3 orphan ingest_plan_items temizle (54, 107, 108) | open, audit-traced maintenance pattern bekliyor |
| **P2** 🔴 | Restore drill execution + log/kanıt | open |
| **P2** 🔴 | API log retention (Loki/Promtail) — gelecek burst post-mortem için | open |
| **P3** | Follow-up'lar (OPTA drift scan, Tekyon /channels UX, healthcheck'ler) | proje düzeyinde |

### Final Hüküm

**Production-ready, host kaybı senaryosu hariç.** Kod düzeyinde kritik gap yok. Operasyonel hijyen + doc kalitesi düzeyinde HIGH bulgular kısmen kapatıldı (`feed1d3`, `05829f8`, `a0946c4`, `0d67c6e`). Açık kalan asıl problemler: **migration baseline-absent** (ayrı tasarım PR'ı), **off-host backup** (credential bekliyor — `9925422` requirements doc), **soft-delete schema redesign** (ayrı PR). UI dead code (LOW-1) ve canEdit reactive (MED-005) `feed1d3` ile temizlendi.

---

*İlk audit fazı (2026-05-01) read-only modda hazırlandı. Doküman sonradan iteratif olarak güncellendi: kapatılan bulgular ✅ ile işaretlendi, line ref'ler tazelendi, iç tutarsızlıklar düzeltildi. Aksiyon kararları kullanıcıya bırakılmaya devam ediyor.*
