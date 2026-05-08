# Schedule/Yayın Planlama Cleanup V1 (SCHED-B5a + B5b)

> **Status**: ✅ Locked (2026-05-08; revize 2026-05-08 → iki faza bölündü). Implementation gate for SCHED-B5a (safe cleanup) ve SCHED-B5b (reporting canonicalization + hard drops).
> **Tarih**: 2026-05-08
> **Cross-reference**:
> - `ops/REQUIREMENTS-SCHEDULE-BROADCAST-FLOW-V1.md` (K-B3.1-K-B3.27)
> - `ops/REQUIREMENTS-SCHEDULE-OPTA-SYNC-V1.md` (KO1-KO14)
> - `ops/REQUIREMENTS-SCHEDULE-FRONTEND-V1.md` (Y4-1..Y4-10 + Y4-4 revize)
> - `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §3.5 K16

**Faz ayrımı (preflight 2026-05-08 sonrası revize)**: Reporting `/schedules/reporting`, `metadata.contentName`/`metadata.houseNumber`, `start_time`, `end_time` kolonlarına bağlı. Drop edilirse reporting kırılır. Patron kararı: **B5'i iki faza böl, reporting'i kırarak drop yapma**.

- **B5a (Safe Cleanup)**: Frontend/backend legacy code DELETE + nav final + ingest coupling kaldır + legacy row DELETE + dependency sıfırlama. `usage_scope` kod dependency'si sıfırlanır; **`metadata`/`start_time`/`end_time` DROP YOK**.
- **B5b (Reporting Canonicalization + Hard Drops)**: Reporting refactor (canonical alanlara taşı; gerekirse yeni structured kolon: `house_number`, `content_name`, `event_duration_min` veya `event_end_time`); sonra `metadata`/`start_time`/`end_time` (ve B5a'da kalan kolonlar) DROP edilir.

## §0 — Status & cross-references

Bu doc SCHED-B5 destructive cleanup scope lock'unu kayıt altına alır. **Read-only inventory + Y5-1..Y5-8 lock'lar + migration runbook**. Implementation ayrı PR; bu doc onayından sonra başlar.

**Patron yönergesi (2026-05-08)**: Event verisi önemsiz olduğu için agresif cleanup kabul edilebilir; ancak runbook + DB constraint sırası + dış sistem (BXF/ingest) bağımlılığı temizliği yine zorunlu. Yanlış DB constraint veya legacy importer sessiz veri akışı **mimari risk**.

**İlişkili lock'lar bağlamı**:
- K-B3.x backend canonical (event_key + 3 channel slot + 3 lookup) — B3a/B3b/B3c shipped
- KO1-KO14 OPTA cascade — B3c shipped (legacy `metadata.transStart/End` cascade kaldırıldı)
- Y4-1..Y4-10 + Y4-4 revize — B4 frontend shipped (eski schedule-list **B5'e kadar paralel** korundu)
- Y5-1..Y5-8 (bu doc) — destructive cleanup

---

## §1 — Read-only inventory snapshot (2026-05-08)

### §1.1 DB row counts

| Metric | Count |
|--------|-------|
| `schedules` total | **132** |
| usage_scope='broadcast' | 0 |
| usage_scope='live-plan' | 132 (TÜMÜ) |
| event_key NULL | 132 (TÜMÜ) |
| canonical complete (event_key + selectedLpe + scheduleDate + scheduleTime) | **0** |
| metadata.transStart key | 132 |
| metadata.optaMatchId key | 132 |
| schedules.deleted_at NOT NULL | 1 |
| `live_plan_entries` total | 2 (sourceType='MANUAL'; sourceType='OPTA' = 0) |

**Bulgu**: Tüm schedule satırları legacy. DELETE filter `event_key IS NULL OR usage_scope='live-plan'` aynı 132 satırı kapsar.

### §1.2 Cascade impact

| Tablo (FK→schedules) | NOT NULL count | onDelete |
|----------------------|---------------|----------|
| `timeline_events` | 0 | Cascade |
| `bookings` | 0 | Cascade |
| `incidents` | 0 | Cascade |

**Bulgu**: 132 schedule DELETE'i 0 sıfır cascade-impact (referans yok).

### §1.3 Constraint + index inventory (schedules)

**B5 DROP edilecek**:
- CHECK: `schedules_usage_scope_check`
- EXCLUSION: `schedules_no_channel_time_overlap` (legacy `channel_id + start/end_time`)
- FK: `schedules_channel_id_fkey` (legacy single-channel)
- INDEX: `schedules_usage_scope_idx`, `schedules_usage_scope_report_..._idx`, `schedules_channel_id_start_time_end_time_idx`, `schedules_deleted_at_idx`

**Korunan**:
- PK `schedules_pkey`
- UNIQUE `schedules_event_key_uniq` (B3a)
- CHECK `schedules_channel_slots_distinct` (same-row duplicate, Y5-5 gerekçesinde lock'lu)
- FK: `schedules_match_id_fkey`, `schedules_broadcast_type_id_fkey`, `schedules_channel_1/2/3_id_fkey`, `schedules_commercial/logo/format_option_id_fkey`, `schedules_selected_live_plan_entry_id_fkey`
- INDEX: `schedules_match_id_idx`, `schedules_status_idx`, `schedules_opta_match_id_idx`

---

## §2 — Y5 Locked Decisions

### Y5-1 — B5 sonrası nav (Y4-4 revize sonrası nihai)

**Karar**:
- "Canlı Yayın Plan" sekmesi → **`/live-plan`** route (M5 canonical)
- "Live-Plan (yeni)" geçici label **geri gelmeyecek**
- "Yayın Planlama" sekmesi → `/yayin-planlama` (kalıcı)
- `/schedules` root → `/yayin-planlama` redirect (B5 sonrası geçerli; B4'te eski schedule-list paralel)
- `/schedules/reporting` korunur (raporlama ayrı domain; cleanup sonrası ayrı revize)

**Gerekçe**: B5 destructive cleanup ile eski schedule-list silindiğinde "Canlı Yayın Plan" sekmesinin eski `/schedules` UI'da kalması imkansız. Yeni canonical Canlı Yayın Plan domain'i `/live-plan` (M5).

### Y5-2a — B5a Safe Cleanup (preflight revize 2026-05-08)

**B5a kapsamı**:

**Kod tarafı dependency sıfırlama**:
- `usage_scope` kod dependency'si tamamen kaldırılır (backend service/route/import/export + frontend ScheduleService + ingest coupling + dashboard)
- Eski `start_time`/`end_time` kod kullanımı **frontend** silinir (schedule-list/form/detail DELETE; Y5-3); **backend reporting/export bağımlılığı B5a'da KORUNUR** (B5b'de canonicalize)
- `metadata` kod kullanımı reporting dışında temizlenir; reporting `metadata.contentName/houseNumber` B5b'de canonicalize

**Legacy row DELETE** (B5a'da):
- Filter: `event_key IS NULL OR usage_scope='live-plan'` (132 row; 0 FK cascade impact)
- Reporting'in B5a'da gösterdiği veri etkilenmez (zaten legacy/empty data)

**B5a'da DROP edilebilen** (kod dependency sıfırlandıktan sonra):
| Kolon/Constraint/Index | Şart |
|-----------------------|------|
| `schedules_usage_scope_check` CHECK | usage_scope kod dependency sıfırlanırsa |
| `schedules_usage_scope_idx` | aynı |
| `schedules_usage_scope_report_..._idx` | aynı |
| `schedules_no_channel_time_overlap` GiST | start_time/end_time hala kolon olarak DURUR; **exclusion DROP B5a'da yapılabilir** (Y5-5) |
| `schedules_channel_id_fkey` FK + `schedules.channel_id` kolon | dependency sıfırsa (kod taraması zorunlu) |
| `schedules.deleted_at` kolon + `schedules_deleted_at_idx` | dependency sıfırsa |
| **`schedules.usage_scope` kolon** | **dependency sıfırlandıktan sonra DROP edilebilir; reporting `usageScope='live-plan'` filter B5a'da `eventKey IS NOT NULL` veya benzeri canonical filter'a refactor edilirse DROP kabul** |

**B5a'da DROP EDİLMEZ**:
- `schedules.metadata` (B5b'ye ertelendi — `contentName`/`houseNumber` reporting bağımlılığı)
- `schedules.start_time` (B5b — reporting derive)
- `schedules.end_time` (B5b — reporting duration calc + tablo kolonu)

### Y5-2b — B5b Reporting Canonicalization + Hard Drops

**B5b kapsamı**:
1. **Reporting refactor**: `schedule.export.ts` + `schedule.routes.ts:/reports/live-plan*` + `reporting/schedule-reporting.component.ts` canonical alanlara taşınır
2. **Yeni structured kolon kararı** (gerekirse):
   - `schedules.content_name VARCHAR(500)` (metadata.contentName karşılığı)
   - `schedules.house_number VARCHAR(50)` (metadata.houseNumber karşılığı)
   - `schedules.event_duration_min INT` veya `schedules.event_end_time TIMESTAMPTZ` (reporting duration calc + endTime)
   - **B5b başlangıcında karar**: yeni kolon eklemek vs reporting UI'dan kolonları çıkarmak
3. **Hard DROP** (reporting canonicalize edildikten sonra):
   - `schedules.metadata` + ilgili JSON key kullanımı temiz
   - `schedules.start_time`
   - `schedules.end_time`
   - B5a'dan kalan ne varsa (`channel_id`, `deleted_at` vs.)

**Sırayla**: Reporting refactor → smoke + Karma + Playwright → ALTER TABLE DROP COLUMN.

### Y5-3 — Frontend cleanup

**Karar**: Aşağıdaki path'ler B5 migration'ında **DELETE** edilir:

| Path | Aksiyon |
|------|---------|
| `apps/web/src/app/features/schedules/schedule-list/` | DELETE (~2200 satır) |
| `apps/web/src/app/features/schedules/schedule-form/` | DELETE |
| `apps/web/src/app/features/schedules/schedule-detail/` | DELETE |
| `apps/web/src/app/core/services/schedule.service.ts` | DELETE (yayin-planlama.service yeni canonical) |
| `apps/web/src/app/features/schedules/reporting/` | KORUNUR |
| `apps/web/src/app/features/schedules/schedules.routes.ts` | Refactor: root `''` → `/yayin-planlama` redirect; `reporting` korunur; `new`/`:id`/`:id/edit` DELETE |
| `apps/web/src/app/app.component.ts` | "Canlı Yayın Plan" route `/schedules` → `/live-plan` (Y5-1) |
| `apps/web/src/app/app.routes.ts` | Wildcard `**` → `/yayin-planlama` (Y5-1; eski default `/schedules` artık redirect) |
| `apps/web/src/app/features/dashboard/dashboard.component.ts` | ScheduleService bağımlılığı **kaldır** (Y5-7 paritesi) |
| `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts:1524` | `usageScope: 'live-plan'` ref kaldır (Y5-7 paritesi) |
| `tests/playwright/yayin-planlama.spec.ts` | Y5-1 yeni nav + redirect test'leri güncel |

### Y5-4 — Backend cleanup

**Karar**: Aşağıdaki backend path'leri B5 migration'ında refactor/delete:

| Path | Aksiyon |
|------|---------|
| `apps/api/src/modules/schedules/schedule.routes.ts` | Legacy `GET /` (root list), `POST /`, `PATCH /:id`, `DELETE /:id` **DELETE** |
| `apps/api/src/modules/schedules/schedule.routes.ts` | `GET /:id` korunur veya `/broadcast/:id` paritesinde refactor (yayin-planlama getById bağımlı) |
| `apps/api/src/modules/schedules/schedule.routes.ts` | `GET /export`, `GET /reports/live-plan*`, `GET /ingest-candidates` **canonical uyumuna refactor** |
| `apps/api/src/modules/schedules/schedule.schema.ts` | `createScheduleSchema`, `updateScheduleSchema`, `scheduleQuerySchema.usage` field DELETE |
| `apps/api/src/modules/schedules/schedule.service.ts` | `findAll(usage)`, `findById`, `create/update/remove` legacy method'lar DELETE; `attachIngestPorts` `usage_scope='live-plan'` filter kaldır |
| `apps/api/src/modules/schedules/schedule.import.ts` | **Legacy BXF importer DISABLE veya DELETE** (Y5-6) |
| `apps/api/src/modules/schedules/schedule.export.ts` | Refactor: `start_time` order → `scheduleDate + scheduleTime`; `usage` query DELETE |
| `apps/api/src/modules/ingest/ingest.service.ts:56` | `usage_scope='live-plan'` coupling DELETE; `live_plan_entries` temelli filtreye geç (Y5-7) |
| Test'ler | Legacy spec'ler DELETE/refactor (`schedule.service.integration`, `schedule-opta-match-id`, `db-constraints` usage_scope CHECK testi, `ingest.service.integration` coupling) |

### Y5-5 — DB exclusion constraint

**Karar**:
- Eski `schedules_no_channel_time_overlap` GiST exclusion **DROP**.
- **B5'te yeni cross-row canonical overlap constraint TASARLANMAZ**.
- Same-row duplicate channel kontrolü `schedules_channel_slots_distinct` ile **korunur**.
- Cross-row 3-channel-slot + scheduleDate+scheduleTime + duration overlap modeli ayrı PR'da tasarlanır (yanlış constraint production'da gereksiz 409 üretir).

**Gerekçe**: 3 kanal slot + scheduleDate/scheduleTime + duration modeli şu an tam net değil. Acele DB constraint application-level edge case'ler doğurabilir.

### Y5-6 — Legacy BXF importer

**Karar**: Eski BXF importer (`schedule.import.ts`) **disable/delete** (B5'te).

**Gerekçe**: Eski importer `metadata + start/end_time + usage_scope` üzerinden veri sokuyor. B5 sonrası bu yasak (legacy alan).

**Replacement**: Eğer BXF import işlevselliği gerekli ise **ayrı PR** ile broadcast flow canonical (event_key + selectedLpe + scheduleDate/Time + 3 channel slot + 3 lookup) modeline göre yeniden tasarlanır. B5 kapsamı dışı.

### Y5-7 — Cross-domain dependency cleanup

**Karar**:
- **Dashboard `ScheduleService`**: bağımlılık kaldırılır. Eğer dashboard sayı/liste gösterimi gerekiyorsa `YayinPlanlamaService` veya doğrudan canonical endpoint kullanılır (B4 service paritesi).
- **Ingest `usage_scope='live-plan'` coupling**: kaldırılır. Ingest, Schedule/Yayın Planlama'dan veri ALMAZ; `live_plan_entries` üzerinden çalışır (Domain Ownership LOCKED — `ingest_plan_items.live_plan_entry_id` FK).
- **`ingest-list.component.ts:1524`**: `usageScope: 'live-plan'` ref kaldırılır.

**Gerekçe**: Domain Ownership lock (memory) — Canlı Yayın Plan / Stüdyo Planı / Ingest ayrı domain; cross-domain yetki yasak. B5'te bu cleanup tamamlanır.

### Y5-8 — DROP CANDIDATE / follow-up (B5'te DROP YOK)

**Karar**: Aşağıdaki kolonlar **DROP CANDIDATE** olarak işaretlenir; B5'te DROP edilmez. Kullanım inventory + sonraki PR ile değerlendirilir:

| Kolon | Inventory gerek |
|-------|-----------------|
| `schedules.broadcast_type_id` | Reporting/export kullanım grep + canonical broadcast flow'da yer var mı? |
| `schedules.content_id` | Eski Madde 3 şemadan kalan; kullanım grep |
| `schedules.finished_at` | MCR/dashboard "biten yayın" işaretlemesi olabilir; kullanım grep |

**Sebep**: Bu üç alan reporting/export/dashboard tarafından kullanılıyor olabilir. B5'te direkt DROP yanlış sessiz break üretebilir. Doğru sıra: B5 sonrası ayrı follow-up turunda inventory + DROP/refactor.

---

## §3 — Implementation checklist (B5 PR scope)

### §3.1a B5a DB migration (preflight revize 2026-05-08)

```sql
-- B5a: Safe cleanup — kod dependency sıfırlandıktan sonra; reporting kırılmaz.

-- 1. Legacy row DELETE (cascade FK 0 impact)
DELETE FROM schedules WHERE event_key IS NULL;

-- 2. Legacy GiST exclusion DROP (yeni cross-row overlap B5'te YOK; Y5-5)
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_no_channel_time_overlap;

-- 3. CHECK + FK DROP (usage_scope/channel_id dependency sıfırsa)
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_usage_scope_check;
ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_channel_id_fkey;

-- 4. Index DROP (kolon DROP'tan önce)
DROP INDEX IF EXISTS schedules_usage_scope_idx;
DROP INDEX IF EXISTS schedules_usage_scope_report_league_report_season_report_we_idx;
DROP INDEX IF EXISTS schedules_channel_id_start_time_end_time_idx;
DROP INDEX IF EXISTS schedules_deleted_at_idx;

-- 5. Kolon DROP (B5a — reporting bağımlı OLMAYANLAR)
ALTER TABLE schedules
  DROP COLUMN IF EXISTS usage_scope,
  DROP COLUMN IF EXISTS channel_id,
  DROP COLUMN IF EXISTS deleted_at;

-- B5a YAPMAZ: metadata, start_time, end_time DROP (reporting bağımlı; B5b'ye ertelendi)
```

### §3.1b B5b DB migration (canonicalization sonrası)

```sql
-- B5b: Reporting canonical alanlara taşındıktan ve smoke geçtikten sonra.

-- 1. (Opsiyonel) Yeni structured kolon ekle (B5b başlangıcında karar)
-- ALTER TABLE schedules
--   ADD COLUMN content_name VARCHAR(500),
--   ADD COLUMN house_number VARCHAR(50),
--   ADD COLUMN event_duration_min INT;       -- veya event_end_time TIMESTAMPTZ
-- (data backfill metadata'dan veya reporting'e karşılığı UI'dan kaldırma kararına göre)

-- 2. Hard DROP (reporting canonicalize sonrası; smoke yeşil olduktan sonra)
ALTER TABLE schedules
  DROP COLUMN IF EXISTS metadata,
  DROP COLUMN IF EXISTS start_time,
  DROP COLUMN IF EXISTS end_time;
```

### §3.2 Backend changes

- `schedule.routes.ts`: legacy endpoint'ler DELETE
- `schedule.schema.ts`: legacy schemas DELETE
- `schedule.service.ts`: legacy methods DELETE; broadcast flow korunur
- `schedule.import.ts`: DISABLE/DELETE
- `schedule.export.ts`: canonical alanlara refactor (start_time order → scheduleDate+scheduleTime; usage filter DELETE)
- **Reporting canonical uyumu** (§6.1): `schedule.routes.ts:/reports/live-plan*` + `reporting/schedule-reporting.component.ts` DROP edilen kolonlara (`usage_scope`/`start_time`/`end_time`/`metadata`/`deleted_at`) bağlı ise canonical karşılıklarına bağla; ürün davranışı birebir korunur. Implementation başlangıcında reporting dependency inventory zorunlu.
- `ingest.service.ts`: usage_scope coupling DELETE
- Schema.prisma: Schedule model'inden DROP NOW alanları temizle
- Prisma client regenerate
- Test'ler: legacy spec DELETE; broadcast flow + opta cascade + lookup spec'ler korunur

### §3.3 Frontend changes

- `schedule-list/`, `schedule-form/`, `schedule-detail/` dizinleri DELETE
- `core/services/schedule.service.ts` DELETE
- `schedules.routes.ts` refactor (root redirect + reporting only)
- `app.component.ts` nav: "Canlı Yayın Plan" → `/live-plan`
- `app.routes.ts` wildcard → `/yayin-planlama`
- `dashboard.component.ts` ScheduleService bağımlılık kaldır
- `ingest-list.component.ts` `usageScope: 'live-plan'` ref kaldır
- Playwright spec güncel (Y5-1 nav + redirect)

### §3.4 Test impact (DELETE/refactor)

- `schedule.service.integration.spec.ts`: legacy path DELETE
- `schedule-opta-match-id.integration.spec.ts`: usage filter refactor
- `db-constraints.integration.spec.ts`: usage_scope CHECK testi DELETE
- `ingest.service.integration.spec.ts`: usage_scope coupling refactor

---

## §4 — Test gates (commit/push öncesi zorunlu)

| Gate | Hedef |
|------|-------|
| Backend lint | EXIT=0 |
| Backend full integration | tüm spec'ler yeşil (B3a/B3b/B3c/B4-prep + lookup korunur) |
| Web typecheck (app + spec) | EXIT=0 |
| Karma component test | TÜMÜ yeşil |
| Playwright chromium + mobile-chrome | yayin-planlama.spec.ts + redirect/nav güncel; tümü yeşil |
| Route smoke (manuel veya Playwright) | `/schedules` → `/yayin-planlama` redirect; `/schedules/reporting` 200; `/live-plan` Canlı Yayın Plan UI; `/yayin-planlama` Yayın Planlama UI |

---

## §5 — Migration runbook (Y5-7 backup + sıra)

### §5.1 Local docker compose runtime DB

1. **Backup zorunlu** (`pg_dump bcms` → `backups/bcms-runtime-before-b5-cleanup-<TARIH>.sql`)
2. `prisma migrate deploy` (yeni B5 migration applied)
3. Web + API container rebuild
4. Smoke: `/yayin-planlama`, `/schedules` redirect, `/schedules/reporting`, Canlı Yayın Plan link
5. Playwright koşum (chromium + mobile-chrome)
6. API log'da P2022 / undefined column kontrol — temiz olmalı

### §5.2 Production cloud DB (B5 deploy)

**Bu B5 doc local runtime yetkisi içindir. Production cloud DB için:**
- Production-grade backup (point-in-time recovery + offsite)
- Maintenance window planla
- Migration sırası: backup → row delete → constraint drop → index drop → column drop → app deploy
- Rollback plan: column drop sonrası geri dönüş için backup zorunlu (`pg_restore` veya kolonları geri ekleyen reverse migration; dikkat — drop kolon data kaybı kalıcı)
- **Açık kullanıcı onayı** (her aşama)

### §5.3 Rollback notu

Column drop **destructive**, geri dönüş için backup gerekli. Eğer migration apply sonrası app boot/smoke fail ederse:
- Container'lar eski image'a revert (web + api)
- DB rollback: backup'tan restore (rebuild_from_backup runbook)
- Migration revert: yeni reverse migration (kolonları geri ekle; data kaybı backup ile telafi)

---

## §6 — Out of scope (B5 YAPMAZ)

- **Yeni cross-row overlap constraint** (Y5-5; ayrı PR)
- **DROP CANDIDATE kolonlar** (Y5-8; broadcast_type_id / content_id / finished_at — follow-up inventory + ayrı PR)
- **BXF importer replacement** (Y5-6; ayrı PR)
- **Büyük reporting ürün revizyonu / advanced reporting redesign** (ayrı PR — UI yeniden tasarımı, yeni rapor şemaları, vs.)
- **M5-B10b technical-details form** (öncelik sırası: 3.)
- **PR-C2 outbox cut-over** (öncelik sırası: 4.)
- **PR-D replay/retention** (öncelik sırası: 5.)
- **Production cloud DB deploy** (ayrı backup + runbook + onay)

### §6.1 Reporting kapsamı (preflight 2026-05-08 revize: faz ayrımı)

`/schedules/reporting` UI'sı **B5a'da kırılmaz** (Y5-1). Reporting backend/frontend `metadata.contentName`/`metadata.houseNumber`/`start_time`/`end_time` kullanımı **B5b'ye taşındı**:

- **B5a**: reporting `usage_scope` filter'ı `eventKey IS NOT NULL` veya canonical filter'a refactor edilir (kolon DROP olabilir hale getirilir). `metadata.contentName/houseNumber/start_time/end_time` reporting'de **dokunulmaz** (kolonlar DURUR).
- **B5b**: reporting'in canonical alanlara tam taşınması:
  - `start_time` → `scheduleDate + scheduleTime` derive
  - `end_time` → yeni `event_end_time` kolonu **veya** `event_duration_min` ile derive **veya** UI'dan endTime kolon kaldırma (B5b başlangıcında karar)
  - `metadata.contentName` → yeni `content_name` kolon **veya** UI'dan kaldırma
  - `metadata.houseNumber` → yeni `house_number` kolon **veya** UI'dan kaldırma
- B5b'de smoke + Karma + Playwright yeşil olduktan **sonra** `metadata`/`start_time`/`end_time` DROP edilir.
- Ürün davranışı (rapor çıktıları, kolonlar) B5a'da **birebir korunur**; B5b'de canonical alanlardan beslenir; advanced reporting redesign ayrı PR.

---

## §7 — Open follow-ups (B5 sonrası)

| Konu | Açıklama |
|------|----------|
| `broadcast_type_id` / `content_id` / `finished_at` DROP CANDIDATE | Y5-8 — kullanım inventory + ayrı PR |
| Cross-row canonical overlap constraint | Y5-5 — 3 channel slot + scheduleDate/Time + duration modellemesi netleştikten sonra |
| BXF importer replacement | Y5-6 — broadcast flow canonical'a uyumlu yeni importer (gerekiyorsa) |
| Reporting product redesign / advanced reporting revizyonu | UI yeniden tasarımı + yeni rapor şemaları (B5'te yapılan canonical uyumu refactor'dan ayrı; davranışı genişletmez) |
| AGENTS.md / CLAUDE.md `usageScope` instruction güncelleme | B5 deploy sonrası ajan instruction dosyaları (sıra: 2.) |

---

## §8 — Review history

| Tarih | Yorum |
|-------|-------|
| 2026-05-08 | Y5-1..Y5-8 lock'lu (B5 destructive cleanup scope). Read-only inventory + 8 karar + migration runbook. Implementation onayı ayrı turda. |
| 2026-05-08 (preflight revize) | B5 → B5a + B5b iki faza ayrıldı. Reporting `metadata.contentName`/`houseNumber`/`start_time`/`end_time` bağımlılığı bulundu; metadata/start_time/end_time DROP B5a'da YAPILMAZ → B5b'de reporting canonicalization sonrası yapılır. B5a kapsamında: code dependency sıfırlama + frontend DELETE + ingest coupling kaldır + legacy row DELETE + `usage_scope`/`channel_id`/`deleted_at` kolon DROP (dependency sıfırsa). B5b kapsamı: reporting canonical alanlara taşıma + (opsiyonel) yeni structured kolon (`content_name`/`house_number`/`event_end_time` veya `event_duration_min`) + `metadata`/`start_time`/`end_time` DROP. |
