# Schedule OPTA Sync Cascade V1 (SCHED-B3c)

> **Status**: ✅ Locked (2026-05-07). Implementation gate for SCHED-B3c (`ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §3.5 K16 + K-B3 lock).
> **Tarih**: 2026-05-07
> **Cross-reference**:
> - `ops/REQUIREMENTS-SCHEDULE-BROADCAST-FLOW-V1.md` (K-B3.1-K-B3.27, B3a/B3b uygulama spec'i)
> - `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §3.5 (K16 — schedule broadcast flow, live-plan canonical)
> - `apps/api/src/modules/opta/opta.sync.routes.ts` (mevcut implementation; B3c hedefi)

## §0 — Status & cross-references

Bu doc SCHED-B3 üçüncü adım (B3c) öncesi scope lock'unu kayıt altına alır. **Read-only kapsamlı inventory + KO1-KO14 lock'lar + status filtre kararı**. Implementation ayrı PR; bu doc onayından sonra başlar.

**İlişkili lock'lar:**
- K-B3.4: + duplicate açık aksiyon (B3b'de implement edildi)
- K-B3.5: OPTA seçim akışı `/from-opta` (B3b'de implement edildi)
- K-B3.10: aynı `event_key` aktif duplicate engelleme (B3b)
- K-B3.21/22/23: live-plan ↔ schedule reverse sync (B3a/B3b)
- K-B3.16: schedule delete → live-plan channel slot NULL (B3a)
- **KO1-KO14 (bu doc)**: OPTA cascade live-plan + schedule canonical alanları

**İptal olan davranışlar** (B3c'de kaldırılacak):
- Legacy `schedule.updateMany` ile `usage_scope='live-plan'` cascade
- `metadata.transStart/transEnd` JSON shift
- Version mismatch → skip semantiği (cascade için)

---

## §1 — Read-only inventory (mevcut davranış)

### §1.1 Route + auth

| Item | Detay |
|------|-------|
| Route | `apps/api/src/modules/opta/opta.sync.routes.ts:111` |
| Mount | `app.ts:379` → `POST /api/v1/opta/sync` |
| Auth | `Bearer ${OPTA_SYNC_SECRET}` (timing-safe compare) |
| Rate limit | `config: { rateLimit: false }` |
| Çağıran | Python `bcms_opta_watcher` container — batch matches (max 5000) |
| Body | `{ matches: [{ matchUid, compId, compName, homeTeam?, awayTeam?, matchDate, weekNumber?, season?, venue? }] }` |

### §1.2 Yazılan tablolar

| Tablo | Davranış | Notlar |
|-------|----------|--------|
| `leagues` | Upsert; name diff yoksa skip | HIGH-003 audit gürültü engeli (idempotent) |
| `matches` | `createMany skipDuplicates` + matchDate diff varsa update | Update path sadece matchDate; **homeTeam/awayTeam diff izlenmiyor** (B3c'de KO4 ile düzelt) |
| `schedules` | Cascade: `usageScope='live-plan'` + status NOT IN frozen → `startTime/endTime/version++` + `metadata.transStart/transEnd` shift | **KO3 ile rewire**; legacy yol kaldırılır |
| `live_plan_entries` | **HİÇ DOKUNULMUYOR** | B3c'nin doldurduğu boşluk |
| `audit_logs` | Prisma `$extends` extension her create/update yakalar | ALS context boş → `userId='system'` (KO10 ile `system:opta-sync` olur) |
| Outbox shadow events | Yazmıyor | KO11 ile `live_plan.updated` + `schedule.updated` eklenir |
| RabbitMQ `SCHEDULE_UPDATED` | Cascade sonrası best-effort | Korunur (orthogonal event bus) |

### §1.3 Otomatik create

| Tip | Mevcut | B3c kararı |
|-----|--------|-----------|
| `match.create` | EVET | Korunur (B3c kapsamı dışı) |
| `league.create` | EVET | Korunur |
| `schedule.create` | YOK | KO6 — yine YOK |
| `live_plan_entries.create` | YOK | KO6 — yine YOK |

### §1.4 Mevcut cascade davranışı (rewire edilecek)

- `match.matchDate` diff (deltaMs) → schedule `startTime + delta`, `endTime + delta`, `version++`
- `metadata.transStart/transEnd` aynı delta ile shift (`HH:MM` parse, 24h modulo) → **KO5 ile kaldırılır**
- `match.homeTeam/awayTeam` diff → **HİÇ CASCADE YOK** (mevcut sınırlama; KO4 ile düzelt)
- `version` mismatch → skip (drift sinyali) → **KO1 ile kaldırılır** (skip semantiği yanlış)
- `FROZEN_STATUSES` (COMPLETED/CANCELLED/ON_AIR) → schedule cascade YAPMAZ (KO14 korur)

---

## §2 — KO1-KO14 Locked Decisions

### KO1 — Conflict semantics: NO SKIP

**Karar**: Tx içinde güncel satır okunur ve değişiklik varsa update edilir; conflict skip YOK. Concurrent user write varsa DB transaction sırasına göre son commit edilen değer kazanır.

**Gerekçe**: OPTA sync sistem update; kullanıcı If-Match'lı PATCH yapmıyor. Skip semantiği bazı duplicate satırlarda OPTA değişikliğinin uygulanmamasına yol açar — kullanıcı kararına aykırı.

**Uygulama**: Affected satırlar transaction içinde update edilir; concurrent kullanıcı yazımı varsa son yazan kazanır (DB tx semantics). Drift correction otomatik (skip yok).

### KO2 — Cascade orchestration: direct DB writes

**Karar**: OPTA route doğrudan `live_plan_entries` + `schedules` update eder. Endpoint-to-endpoint çağrı YOK.

**Gerekçe**: HTTP loop / yan etki riski (live-plan service.update reverse sync zincirini tekrar tetikler).

**Uygulama**: Ortak helper tercih edilir (örn. `opta-cascade.service.ts` veya inline tx fn); live-plan service'in **update method'u çağrılmaz**.

### KO3 — Schedule cascade: canonical alanlar (Soru 1 → C)

**Karar**: Legacy `schedule.updateMany` ile `usage_scope='live-plan'` + `metadata.transStart/transEnd` cascade **KALDIRILIR**.

Yeni canonical cascade alanları:
- `title`
- `team_1_name`, `team_2_name`
- `schedule_date`, `schedule_time`
- `version++`

Legacy `start_time` / `end_time`: B5 destructive cleanup'a kadar **placeholder dual-write** (NOT NULL doyurma; `composeUtc(scheduleDate, scheduleTime)` + 2h placeholder pattern, schedule.service.ts paritesi).

`metadata.transStart/transEnd`: artık güncellenmez (KO5).

### KO4 — Match takım adı diff (Soru 2 → A)

**Karar**: `homeTeam`/`awayTeam` diff B3c kapsamında.

**Uygulama**:
- `toUpdate` listesi yakalar (matchDate'e ek olarak homeTeam/awayTeam diff)
- `match.update` data: matchDate (varsa) + homeTeamName + awayTeamName (diff varsa)
- Live-plan + schedule cascade: team1/team2 alanlarını OPTA homeTeam/awayTeam'den kopyalar

### KO5 — metadata.transStart/transEnd shift KALDIR (Soru 3 → A)

**Karar**: OPTA cascade artık JSON `metadata.transStart/transEnd` alanlarını shift ETMEZ.

**Gerekçe**: JSON yolu canonical değil; canonical alanlar (`schedule_time`) zaten cascade ediliyor.

**Migration impact**: Kolon B5'e kadar durabilir (mevcut data); yeni sync yaşatmaz. `shiftTimeOfDay` fonksiyonu B3c'de kaldırılır veya ölü kod olarak işaretlenir.

### KO6 — Create yok

OPTA sync **yeni `live_plan_entries` veya `schedules` YARATMAZ**. Sadece existing (sourceType='OPTA') satırları update eder.

**Gerekçe**: Yeni entry yaratımı manuel `/from-opta` aksiyonuna ait (B3b — kullanıcı seçer). OPTA sync'in otomatik create yapması kullanıcı niyeti dışı satır üretir.

### KO7 — Live-plan target filtre

```sql
WHERE source_type = 'OPTA'
  AND event_key  = 'opta:<matchUid>'
  AND deleted_at IS NULL  -- defansif (hard-delete sonrası no-op)
  AND status NOT IN ('COMPLETED', 'CANCELLED')  -- KO14
```

**Çoklu hedef**: Aynı `event_key` için birden fazla satır olabilir (B3b duplicate akışı). **Hepsi** update edilir.

### KO8 — Dokunulmayacak alanlar

Aşağıdaki alanlar / tablolar OPTA cascade kapsamı **DIŞINDA**:

| Alan / Tablo | Kapsam |
|--------------|--------|
| `live_plan_technical_details` | Tüm tablo (M5-B7 kapsamı) |
| `live_plan_transmission_segments` | Tüm tablo (M5-B8 kapsamı) |
| `live_plan_entries.channel_1/2/3_id` | Channel slot (B3a propagation) |
| `live_plan_entries.status` | OPERATOR alanı |
| `live_plan_entries.operation_notes` | OPERATOR alanı |
| `schedules.channel_1/2/3_id` | Schedule channel slot |
| `schedules.commercial_option_id` | Lookup FK |
| `schedules.logo_option_id` | Lookup FK |
| `schedules.format_option_id` | Lookup FK |
| `ingest_plan_items` | Tüm tablo (Madde 4 kapsamı) |

### KO9 — Live-plan update alanları

| Alan | Kaynak | Notlar |
|------|--------|--------|
| `eventStartTime` | `match.matchDate` (B3b createFromOpta paritesi) | UTC |
| `eventEndTime` | `eventStartTime + duration` | duration = mevcut `eventEndTime - eventStartTime`; sıfır/negatifse default 2h (B3b paritesi) |
| `team1Name` | `match.homeTeamName` | KO4 |
| `team2Name` | `match.awayTeamName` | KO4 |
| `optaMatchId` | `match.optaUid` (canonical) | B3b paritesi (request input değil DB) |
| `matchId` | `match.id` | FK; sourceType='OPTA' satırları için zaten dolu |
| `version` | `++` | Optimistic lock (KO1: skip yok) |

### KO10 — Actor: `system:opta-sync`

**Karar**: Audit log actor adı `system:opta-sync`. Mevcut jenerik `'system'` fallback ayrılır.

**Uygulama**: Sync route entry'sinde audit ALS context'ine `userId='system:opta-sync'` enjekte (`als.run({ userId: 'system:opta-sync', ... }, ...)` veya manual override).

**Etki**: Audit log'da bu satırlar OPTA cascade kaynağı olarak filtrelenebilir (rapor + drift inceleme).

### KO11 — Outbox: per changed entry + schedule

| Event | Kapsam |
|-------|--------|
| `live_plan.updated` | Her **gerçekten değişmiş** live-plan entry için bir event |
| `schedule.updated` | Her **gerçekten değişmiş** schedule için bir event |

`status`: `published` (Phase 2 paritesi — poller pick etmez).

**Payload minimum**: `{ livePlanEntryId / scheduleId, source: 'opta-sync', changedFields: [...] }`.

### KO12 — Only-changed-fields update

**Karar**: Diff hesaplanır; değişiklik yoksa `update` YOK (idempotent).

**Gerekçe**: Audit gürültü engeli (league sync paritesi — HIGH-003). Outbox da değişiklik yoksa yazılmaz.

**Uygulama**: Her entry/schedule için before-snapshot ↔ new value compare; sadece farklı alanlar update'e dahil; tüm alanlar aynı ise tablo dokunulmaz.

### KO13 — SyncResponse genişletme

```ts
interface SyncResponse {
  inserted: number;
  updated: number;       // matches updated count (matchDate VEYA team diff)
  unchanged: number;
  cascadedSchedules: number;
  cascadedLivePlanEntries: number;        // YENİ
  livePlanCascadeConflicts: number;       // YENİ (tx error count)
  cascadeConflicts: number;                // KO1 sonrası: yalnız tx error (skip yok)
  manualReconcileRequired: boolean;
  cascadeError?: string | null;
}
```

### KO14 — Status filtre kararı (Soru 4 → B)

| Tablo | Skip status |
|-------|-------------|
| `live_plan_entries` | `status IN ('COMPLETED', 'CANCELLED')` |
| `schedules` | `status IN ('COMPLETED', 'CANCELLED', 'ON_AIR')` (mevcut FROZEN_STATUSES korunur) |

**Gerekçe**:
- COMPLETED: geçmiş/bitmiş operasyon. OPTA sonradan düzeltme gönderirse geçmiş raporu ve operasyon kaydını değiştirmemeli.
- CANCELLED: iptal edilmiş operasyon. OPTA güncellemesiyle tekrar "yaşıyor" gibi davranmamalı.
- IN_PROGRESS (live-plan): **skip YOK**. Canlı yayında OPTA saat/takım düzeltmesi gelirse temel event bilgisi güncel kalmalı. Teknik detay/transmisyon/kanal zaten KO8 ile dokunulmaz.
- ON_AIR (schedule): operasyonel risk koruması (MCR ekibi sürpriz engeli) — mevcut davranış korunur.

**Live-plan IN_PROGRESS güncellenebilir**, schedule ON_AIR güncellenmez — fark bilinçli (live-plan = planlama domain'i, schedule = MCR yayın domain'i).

---

## §3 — Implementation checklist (B3c PR scope)

### §3.1 Kod değişiklikleri

| Dosya | Değişiklik |
|-------|-----------|
| `apps/api/src/modules/opta/opta.sync.routes.ts` | `toUpdate` listesi: matchDate + homeTeam/awayTeam diff yakala (KO4) |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | `match.update` data genişlet (homeTeamName + awayTeamName diff) |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | Yeni cascade bloğu: `live_plan_entries` filter (KO7 + KO14) → KO9 alanları update + version++ + outbox `live_plan.updated` + only-changed-fields (KO12) |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | Schedule cascade rewire (KO3): canonical alanlar (`title`, `team_1/2_name`, `schedule_date`, `schedule_time`) + dual-write legacy `start_time/end_time` placeholder + outbox `schedule.updated` |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | Legacy `metadata.transStart/transEnd` shift KALDIR (KO5; `shiftTimeOfDay` fonksiyonu kaldırılabilir) |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | Version mismatch → skip semantiği KALDIR (KO1) |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | Status filtre `live_plan_entries` (KO14) |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | SyncResponse genişlet (KO13) |
| `apps/api/src/modules/opta/opta.sync.routes.ts` | Audit actor `system:opta-sync` (KO10) |
| (yeni) helper/service | İsteğe bağlı; kod tekrarı varsa shared helper |

### §3.2 Test scope

- OPTA sync: yeni match → live-plan create EDİLMEZ (KO6)
- OPTA sync: matchDate diff → live-plan eventStartTime + eventEndTime cascade (duration korunur)
- OPTA sync: homeTeam/awayTeam diff → live-plan team1/2Name cascade (KO4)
- OPTA sync: schedule cascade canonical alanlar (KO3) + legacy placeholder dual-write
- OPTA sync: aynı eventKey duplicate satırların hepsi update (KO7 — multi-target)
- OPTA sync: COMPLETED/CANCELLED live-plan SKIP (KO14)
- OPTA sync: IN_PROGRESS live-plan UPDATE (KO14)
- OPTA sync: ON_AIR schedule SKIP (KO14)
- OPTA sync: only-changed-fields — diff yoksa update YOK + outbox YOK (KO12)
- OPTA sync: outbox `live_plan.updated` + `schedule.updated` payload doğrulama (KO11)
- OPTA sync: actor audit `system:opta-sync` (KO10)
- OPTA sync: `metadata.transStart/transEnd` artık shift edilmez (KO5)
- OPTA sync: version mismatch → skip YOK; tx içinde son yazan kazanır (KO1)

### §3.3 Out of scope (B3c YAPMAZ)

- OPTA → live_plan_technical_details / transmission_segments cascade (KO8)
- OPTA → channel_1/2/3 / commercial/logo/format cascade (KO8)
- OPTA → ingest_plan_items cascade (Madde 4 kapsamı)
- Schedule.usage_scope='live-plan' satırları DELETE (B5 destructive cleanup)
- `metadata.transStart/transEnd` JSON kolonu DROP (B5)
- Frontend (B4 kapsamı)
- OPTA watcher Python tarafı değişikliği (batch protocol stabil)

---

## §4 — Review history

| Tarih | Yorum |
|-------|-------|
| 2026-05-07 | KO1-KO14 + Soru 4 cevabı (B) lock'lu. Implementation gate: bu doc onay sonrası B3c PR açılır. |
