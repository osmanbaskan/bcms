# BCMS Read-Only Audit Report — 2026-05-01 (geç saat)

> **Mod**: Read-only — hiçbir dosya/komut/DB değişikliği yapılmadı.
> **Kapsam**: `apps/api/src` (46 dosya), `apps/web/src` (62 dosya), `packages/shared/src`, Prisma schema + 23 migration, canlı PostgreSQL/RabbitMQ/Keycloak/Docker, README/ops docs, son 30 commit.
> **Süre**: 12.5 dakika, 141 tool çağrısı.
> **Yöntem**: Statik kod analizi + canlı runtime doğrulama (psql SELECT, docker logs/ps, curl health, npx tsc --noEmit).

---

## Triage Notu

İlk taslak agent raporu kullanıcı tarafından review edildi ve şu noktalar revize edildi:

| Eski (taslak) | Revize (final) |
|---|---|
| "CRITICAL 0" + "production-ready" | "0 code-critical + **1 OPS-CRITICAL aday** (off-host backup yok). Production-ready *host kaybı senaryosu hariç*." |
| Migration drift için (a)+(b) eşit ağırlık | Sadece **(a) — FS'e migration directory geri ekle**. (b) `_prisma_migrations` satır silme + DDL re-apply önerilmiyor — Prisma internal state'i bozar. |
| OPTA burst için "caller-bazlı rate limit ilk aksiyon" | Rate limit **son aksiyon**. Doğru sıra: (1) idempotent UPSERT audit dedupe → (2) observability/alert → (3) gerekirse limit. Trusted endpoint'te sert limit gerçek güncellemeleri kaçırır. |
| Soft-delete P2 | **P1** — semantic karar yokluğu yeni endpoint'lerde tutarsızlık üretir, borç büyür. |
| "4 katman Admin bypass tutarlı" | "Centralized bypass mekanizmaları çalışıyor; auto-augment kaldırıldı **ama UI'da kalıntı dead code (`schedule-list:2070`) ve PERMISSIONS convention'da kısmi tutarsızlık var**." |

---

## 1. Executive Summary

| Severity | Count | Kapsam |
|---|---|---|
| 🔴 **CRITICAL (code)** | **0** | Auth bypass, secret leak, race kanıtı, production-stop sınıfı bulgu yok |
| 🟠 **OPS-CRITICAL aday** | **1** | Off-host backup yok — partial mitigation (local volume backup var, host failure'da kaybolur) |
| 🟠 **HIGH** | **3** | Migration drift; doc drift; OPTA League upsert burst |
| 🟡 **MEDIUM** | **5** | Soft-delete filter; redundant GiST; orphan ports; audit growth; canEdit reactive değil |
| 🟢 **LOW** | **4** | Auto-augment dead code; PERMISSIONS namespace; `as any` (audit plugin); console.* (kabul edilebilir) |

**En yüksek 3 risk** (önceliklendirilmiş):
1. **Prisma migration drift** — DB'de 27 finished migration, FS'te 23 → 4 migration DB-only. DR/staging/CI senaryolarında kırılır.
2. **Off-host backup eksikliği (OPS-CRITICAL aday)** — `postgres_backup` sidecar local volume'da dump alıyor; disk/host arızası → backup da kaybolur. Yarım mitigation.
3. **Doc drift** — README + NOTES_FOR_CODEX RBAC ve migration count tutarsız. AI ajanları/yeni developer'lar için aktif yanlış-yönlendirme riski.

**Cross-cutting temalar**:
- **Doc-code drift**: 2026-05-01 RBAC refactor kod tarafında temiz; docs paragrafların yarısı eski "Admin → SystemEng auto-augment" modelinden kalıntı.
- **Soft-delete tutarsızlığı**: 5+ tabloda `deleted_at` kolonu var, sadece `weekly_shifts` queries'te filter var. Diğerlerinde kolon görmezden geliniyor.
- **Audit log büyüme dinamikleri**: 90-gün retention iyi tasarlanmış ama burst senaryolarında throttle/dedupe yok. 2026-04-30'da 9.5 saatlik (00:00–09:30) bir burst gerçekleşmiş — 205,022 satır (toplam audit_logs'un %36'sı), root cause unknown.
- **Race conditions kapatılmış**: DB-level GiST exclusion + P2002 catch ile defense-in-depth. Yapısal güvende.

**Sistem genel sağlığı**: **Production-ready** — *ancak host kaybı senaryosu hariç*. Tüm container'lar healthy, type-check temiz, OPTA cascade ve recording port normalize sağlam, optimistic locking doğru uygulanmış. Kritik kod gap'i yok; HIGH bulgular operasyonel hijyen + doc kalitesi düzeyinde.

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

### HIGH-001 — Prisma migration drift: DB ↔ filesystem uyumsuzluğu

**Lokasyon**: `apps/api/prisma/migrations/` ve `_prisma_migrations` tablosu

**Kanıt** (psql ve `ls`):
```
DB'de 27 finished migration; filesystem'de 23 (migration_lock.toml hariç).
DB'de var ama FS'te yok:
  20260427000000_add_shift_assignments
  20260427003000_fix_indexes_and_cleanup
  20260427160000_add_fks_indexes_cascade_timestamptz
  20260428000000_manual_schema_sync
```

**Açıklama**: 4 migration DB'ye uygulanmış ama repoda yok. Aşağıdaki senaryolar kırılır:
- `prisma migrate deploy` yeni bir ortamda (staging/restore drill) yarım state üretir
- CI/CD pipeline migration başarısı kontrol ederse kırılır
- Postgres backup restore + `migrate deploy` kombinasyonu başarısız olur (zira backup zaten son şemada, FS'teki migration'lar hash check'i kalifiye etmez)

**Etki**: Mevcut production canlı sistemde belirgin bir sorun yok. DR ve env-replication senaryolarında kırılır.

**Önerilen düzeltme** — sadece (a) yolu kabul edilir:
1. **`prisma migrate status`** çalıştır (read-only diagnostic) ve drift'i net tanımla
2. DB'deki bu 4 migration için DDL'i reverse-engineer et (her birinin ne yaptığını belirle — `pg_stat_user_indexes`, `\d table` vb. ile)
3. Bu DDL'leri repoya migration directory olarak ekle: `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`
4. `_prisma_migrations` zaten "applied" olarak işaretli olduğu için yeni migration'lar idempotent — restore drill'de "no pending migrations" döner

**(b) yolu önerilmiyor**: `_prisma_migrations`'tan satır silme + DDL re-apply Prisma'nın internal state'ini kontrolsüz değiştirir; production'da çok riskli.

**Doğrulama**: `npx prisma migrate status` "Database schema is up to date" mesajı ile çıkmalı, hiçbir "missing in filesystem" uyarısı kalmamalı.

---

### HIGH-002 — Doc drift: README + NOTES_FOR_CODEX RBAC ve migration count tutarsız

**Lokasyon**:
- `README.md:254, 270, 277-281, 288-291, 294, 310, 312, 313, 327, 328, 333, 377`
- `ops/NOTES_FOR_CODEX.md:86, 97-110, 133, 148, 196, 354, 374, 376-377`
- `ops/README.md:103, 406, 442`

**Kanıt** (örnekler):
```
README.md:254  "Admin ve SystemEng sistem genelinde tam yetkili kabul edilir."
            ❌ Gerçek: 2026-05-01 commit b3171d9 + 0220b3e ile sadece Admin tam yetkili.

README.md:294  "auth.ts plugin Admin token'ında SystemEng auto-augment yapıyor"
            ❌ Gerçek: auto-augment kaldırıldı (commit 0220b3e); auth.ts:101-104 sadece comment.

README.md:288-291  "Kullanıcılar / Ayarlar / Audit / Dökümanlar = Admin, SystemEng"
            ⚠️ Yarı doğru: bu sekmelerde Admin requireGroup bypass'la geçer; SystemEng explicit listelenir.

README.md:377  "toplam migration sayısı: 21"
            ❌ Gerçek: FS'te 23, DB'de 27 (HIGH-001).

NOTES_FOR_CODEX.md:97-110  "schedules.add: ['SystemEng', 'Booking', ...]"
            ❌ Gerçek (rbac.ts): ['Booking', 'YayınPlanlama'] — SystemEng yok.

ops/README.md:406  "auth.ts:101-102 Admin token'ı SystemEng auto-augment"
            ❌ Gerçek: kaldırıldı.
```

**Açıklama**: 2026-05-01 RBAC refactor sırasında kod doğru yazıldı, fakat doc dosyaları kısmen güncellendi. Aynı dosya içinde hem yeni hem eski model paragrafları ardışık duruyor (README:266 yeni vs :254/:294 eski). NOTES_FOR_CODEX.md Yetki Matrisi (97-110) tamamen eski.

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

**API log retention öneri**: Loki/Promtail veya docker logging driver (json-file rotation) — gelecek burst'leri post-mortem yapabilmek için.

**Doğrulama**: Aynı sync 100 kez ardışık çağrıldığında League satırları için audit_logs sayısı ilk sync'ten sonra sabit kalmalı (0 yeni satır).

---

## 4. MEDIUM Bulgular

### MED-001 — Soft-delete filter eksik (P1, kapsam genişleme riski)

**Lokasyon**: 
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

**Lokasyon**: DB veri kalıntısı (recording_port normalize migration sonrası)

**Kanıt**:
```
psql:
  id=54   source_key='manual:2026-04-25:810:930:1777083508042'      status=WAITING port_count=0
  id=107  source_key='ingest-plan:2026-04-26:870:990:1777153809824' status=WAITING port_count=0
  id=108  source_key='ingest-plan:2026-04-26:870:990:1777153810664' status=WAITING port_count=0
```

**Açıklama**: Recording port normalize migration (20260430140000) replace pattern'i sırasında bir kayıt eski `recording_port=NULL` durumda olabilir. Yeni kod (`PUT /plan/:sourceKey`) port assignment için plannedStart+End non-null + recordingPort non-empty zorunlu kılıyor. Bu 3 kayıt geçişten kalmış.

**Öneri**: Manuel port ata veya orphan-cleanup migration ile temizle. Schema'ya göre legitimate (ports nullable design); production etkisi minimal (3 satır, status=WAITING). UI'da nasıl görünüyor doğrulanmalı (form muhtemelen "kayıt yeri belirsiz" gösterir).

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

### MED-005 — `studio-plan.component.ts canEdit` reactive değil

**Lokasyon**: `apps/web/src/app/features/studio-plan/studio-plan.component.ts:136-141`

**Kanıt**:
```ts
readonly canEdit = computed(() => {
  const parsed = this.keycloak.getKeycloakInstance().tokenParsed as { groups?: string[] } | undefined;
  ...
});
```

**Açıklama**: `tokenParsed` Keycloak instance'ından okunur ama signal değil. `computed()` reactive izleyemez. Token refresh sonrasında groups değişirse component re-render etmez.

**Etki**: Pratik olarak token refresh sırasında groups claim'i değişmez. Risk minimal.

**Öneri**: Diğer component'lerle uyumlu signal pattern (örn. `app.component.ts` ngOnInit'te `_userGroups.set()` ile signal'e atıyor). Bu pattern'i studio-plan'a da uygula.

---

## 5. LOW / Cosmetic

### LOW-1 — `schedule-list.component.ts:2070` Admin auto-augment dead code

**Kanıt**:
```ts
// app.component.ts:161 commit 0220b3e ile auto-augment kaldırıldı
// Ama schedule-list.component.ts:2070 hâlâ:
this._userGroups.set(
  groups.includes(GROUP.Admin)
    ? Array.from(new Set([...groups, GROUP.SystemEng]))
    : groups
);
```

**Açıklama**: Component-local userGroups signal'inde Admin → SystemEng augment hâlâ duruyor. `hasGroup()` helper (line 36-39) Admin için zaten short-circuit yapıyor → bu augment hiçbir yetki kazandırmıyor. **Dead code**, kaldırılabilir. Commit `0220b3e` ile uyumsuz — refactor eksik kaldı.

**Öneri**: Satırı `this._userGroups.set(groups);` olarak sadeleştir. Hiçbir davranış değişmez.

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
- **Postgres backup**: çalışıyor, restore drill geçmiş, rotation aktif (off-host kopya hariç).

### Sistem zayıf olduğu yerler

- **Doc drift** — kod doğru ama docs yanlış-yönlendirme riski (özellikle NOTES_FOR_CODEX AI ajanları için)
- **Migration drift** — DR/CI senaryolarında kırılır
- **Off-host backup yok** — host failure → tüm veri kayıp
- **Audit log inflation potansiyeli** — burst senaryoları için throttle/dedupe yok
- **Soft-delete tutarsızlığı** — net strateji eksik, borç büyür
- **UI dead code kalıntıları** — `schedule-list:2070` Admin auto-augment dead

### Önceliklendirilmiş Aksiyon Planı

| Öncelik | Aksiyon | Effort |
|---|---|---|
| **P0** | HIGH-001: Migration drift çözümü (`prisma migrate status` → 4 migration directory FS'e geri ekle) | 1-2 saat |
| **P0** | HIGH-002: README + ops/NOTES_FOR_CODEX + ops/README RBAC + migration count düzeltme | 30 dk |
| **P0** | OPS-CRITICAL aday: Off-host backup kararı (rsync/S3/borg seçimi + ilk implementasyon) | 1-3 saat |
| **P1** | HIGH-003 (1): Idempotent UPSERT audit dedupe (League upsert için) | 2 saat |
| **P1** | HIGH-003 (2): Observability — Prometheus opta_sync metrics + alert | 1-2 saat |
| **P1** | MED-001: Soft-delete strategy net karar (drop kolon veya filter ekle) | 2-3 saat |
| **P1** | LOW-1: schedule-list:2070 dead code sil | 5 dk |
| **P1** | MED-005: studio-plan canEdit signal pattern'e dönüştür | 30 dk |
| **P2** | MED-002: Redundant GiST drop migration (HIGH-001 sonrası) | 30 dk |
| **P2** | MED-003: 3 orphan ingest_plan_items satırı temizle | 15 dk |
| **P2** | API log retention (Loki/Promtail) — gelecek burst post-mortem için | 1-2 saat |
| **P3** | Follow-up'lar (OPTA drift scan, Tekyon /channels UX, healthcheck'ler) | proje düzeyinde |

### Final Hüküm

**Production-ready, host kaybı senaryosu hariç.** Kod düzeyinde kritik gap yok. Operasyonel hijyen + doc kalitesi düzeyinde 3 HIGH bulgu var (P0 olarak ele alınmalı). Bir adet OPS-CRITICAL aday (off-host backup) — partial mitigation, full coverage gerekiyor. Audit refactor doğru ve tamamlanmış; tek eksik doc senkronizasyonu ve UI dead code temizliği.

---

*Bu rapor read-only modda hazırlandı. Hiçbir kod, DB, Docker veya doc dosyası değiştirilmedi. Aksiyon kararları kullanıcıya bırakıldı.*
