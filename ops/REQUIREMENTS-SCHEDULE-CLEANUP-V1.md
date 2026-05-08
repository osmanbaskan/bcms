# Schedule/Yayın Planlama Cleanup V1 (SCHED-B5a + B5b)

> **Status**: ✅ Locked (2026-05-08; revize 2026-05-08 → iki faza bölündü; **revize 2026-05-08 ikinci kez** → UI delete iptal, datasource migration kararı). Implementation gate for SCHED-B5a (Canlı Yayın Plan UI datasource migration + legacy form/detail cleanup) ve SCHED-B5b (reporting canonicalization + hard drops).
> **Tarih**: 2026-05-08
> **Cross-reference**:
> - `ops/REQUIREMENTS-SCHEDULE-BROADCAST-FLOW-V1.md` (K-B3.1-K-B3.27)
> - `ops/REQUIREMENTS-SCHEDULE-OPTA-SYNC-V1.md` (KO1-KO14)
> - `ops/REQUIREMENTS-SCHEDULE-FRONTEND-V1.md` (Y4-1..Y4-10 + Y4-4 revize)
> - `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §3.5 K16

**İkinci revize ürün kararı (2026-05-08)**: Patron'un asıl talebi "Canlı Yayın Plan sekmesi arayüz hissi korunur, datasource live-plan API'ye taşınır" — route ve arayüz bir şey, datasource başka şey. B5a'nın ilk turunda yapılan "Canlı Yayın Plan → `/live-plan`", "`/schedules` redirect", "schedule-list UI delete" kararları **iptal**. B5a artık **UI delete değil, datasource migration**.

**Faz ayrımı**: Reporting `/schedules/reporting`, `metadata.contentName`/`metadata.houseNumber`, `start_time`, `end_time` kolonlarına bağlı. Drop edilirse reporting kırılır. Patron kararı: **B5'i iki faza böl, reporting'i kırarak drop yapma**.

- **B5a (Canlı Yayın Plan UI datasource migration + legacy form/detail cleanup)**: schedule-list bileşeni **korunur**, datasource'u live-plan API'ye taşınır (LivePlanEntry → SchedulePresentation mapper). schedule-form/schedule-detail **silinir** (Canlı Yayın Plan ekranı bu fazda liste odaklı / read-only). Backend legacy POST/PATCH/DELETE silinmiş kalır (yeni broadcast flow canonical). Nav: "Canlı Yayın Plan" → `/schedules` (eski yer, eski hisse). `usage_scope` kod dependency'si sıfırlanır; **`metadata`/`start_time`/`end_time` DROP YOK**.
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

### Y5-1 — B5 sonrası nav (ikinci revize 2026-05-08)

**Karar (ikinci revize 2026-05-08)**:
- "Canlı Yayın Plan" sekmesi → **`/schedules`** route (eski yer, eski arayüz hissi korunur)
- `/schedules` root → eski schedule-list UI açılır; **redirect YOK**
- schedule-list UI bileşeni datasource olarak **live-plan API** kullanır (LivePlanEntry → SchedulePresentation mapper)
- "Live-Plan (yeni)" nav item **YOK** (geri gelmeyecek)
- `/live-plan` route **korunur** ama nav'da **görünmez** (M5-B10b ileride bu route üstünde çalışabilir)
- "Yayın Planlama" sekmesi → `/yayin-planlama` (kalıcı; broadcast flow yeni canonical UI)
- Wildcard `**` → `/schedules` (eski default)
- `/schedules/reporting` korunur (raporlama ayrı domain; B5b'de canonicalize)

**Gerekçe**: Patron'un kararı route ismi/arayüz ve datasource ayrımına dayanır. Canlı Yayın Plan sekmesi kullanıcı için **arayüz sürekliliği** ister; ama backend datasource canonical olarak live-plan'dadır. UI delete değil, datasource swap. B5a'nın ilk turunda yapılan "Canlı Yayın Plan → /live-plan" + "/schedules redirect" + "schedule-list UI delete" kararları **iptal**.

### Y5-2a — B5a Canlı Yayın Plan UI datasource migration + legacy form/detail cleanup (ikinci revize 2026-05-08)

**B5a kapsamı**:

**Frontend datasource migration** (schedule-list UI):
- `schedule-list/schedule-list.component.ts` **korunur** (~2400 satır UI hissi birebir)
- Datasource artık legacy `/schedules` GET değil, **`/api/v1/live-plan` GET** (M5-B2 endpoint)
- LivePlanEntry → SchedulePresentation mapper; eski kolonlar (title, channel slot, start/end time, status) live-plan alanlarından (eventStartTime/EndTime, channel_1/2/3, team_1/2_name, source_type) türetilir
- `core/services/schedule.service.ts` ya restore edilip live-plan API çağrısına refactor edilir, ya da silinir + bileşen `LivePlanService`/`ApiService` kullanır (implementation tercihi)

**Frontend legacy form/detail DELETE**:
- `schedule-form/` DELETE (create/edit eski schedule UI üstünden olmaz)
- `schedule-detail/` DELETE (detay eski schedule UI üstünden olmaz)
- Canlı Yayın Plan sekmesi B5a'da **liste odaklı / read-only**
- Operasyonel create/edit: Yayın Planlama (`/yayin-planlama`) — broadcast flow canonical UI

**Backend kod tarafı dependency sıfırlama** (B5a Block 1'de yapılmıştı, korunur):
- `usage_scope` kod dependency'si tamamen kaldırılır (backend service/route/import/export + frontend bileşenler + ingest coupling + dashboard)
- Backend legacy `POST /schedules`, `PATCH /schedules/:id`, `DELETE /schedules/:id`, `GET /schedules` (root list) silinmiş kalır — yeni schedule-list UI bunları çağırmaz, live-plan endpoint okur
- Eski `start_time`/`end_time` kod kullanımı **frontend datasource swap** ile dolaylı düşer; **backend reporting/export bağımlılığı B5a'da KORUNUR** (B5b'de canonicalize)
- `metadata` kod kullanımı reporting dışında temizlenir; reporting `metadata.contentName/houseNumber` B5b'de canonicalize

**Legacy row DELETE** (B5a'da):
- Filter: `event_key IS NULL OR usage_scope='live-plan'` (132 row; 0 FK cascade impact)
- Reporting'in B5a'da gösterdiği veri etkilenmez (zaten legacy/empty data)
- Schedule-list UI live-plan datasource'tan beslendiği için bu DELETE Canlı Yayın Plan görünümünü etkilemez

**B5a'da DROP edilebilen** (kod dependency sıfırlandıktan sonra; **Block 2 ayrı onay**):
| Kolon/Constraint/Index | Şart |
|-----------------------|------|
| `schedules_usage_scope_check` CHECK | usage_scope kod dependency sıfırlanırsa |
| `schedules_usage_scope_idx` | aynı |
| `schedules_usage_scope_report_..._idx` | aynı |
| `schedules_no_channel_time_overlap` GiST | start_time/end_time hala kolon olarak DURUR; **exclusion DROP B5a'da yapılabilir** (Y5-5) |
| `schedules_channel_id_fkey` FK + `schedules.channel_id` kolon | dependency sıfırsa (kod taraması zorunlu) |
| `schedules.deleted_at` kolon + `schedules_deleted_at_idx` | dependency sıfırsa |
| **`schedules.usage_scope` kolon** | **dependency sıfırlandıktan sonra DROP edilebilir; reporting filter'ı B5a'da `eventKey IS NOT NULL` canonical filter'a refactor edilir; reporting datasource schedule canonical kalır (Y5-1)** |

**B5a'da DROP EDİLMEZ**:
- `schedules.metadata` (B5b'ye ertelendi — `contentName`/`houseNumber` reporting bağımlılığı)
- `schedules.start_time` (B5b — reporting derive)
- `schedules.end_time` (B5b — reporting duration calc + tablo kolonu)

**B5a'da yapılmayan / ertelenen**:
- Production / cloud DB apply (yalnız local docker compose runtime DB)
- Reporting'in live-plan datasource'a taşınması (Y5-1 — reporting schedule canonical kalır)
- M5-B10b technical-details form (sıra: 3.)

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

### Y5-3 — Frontend cleanup (ikinci revize 2026-05-08)

**Karar**: Aşağıdaki path'ler B5a migration'ında refactor / DELETE edilir:

| Path | Aksiyon |
|------|---------|
| `apps/web/src/app/features/schedules/schedule-list/` | **KORUNUR** — restore edilir; datasource live-plan API'ye taşınır (LivePlanEntry → SchedulePresentation mapper); UI hissi birebir |
| `apps/web/src/app/features/schedules/schedule-form/` | **DELETE** (create/edit eski schedule UI üstünden olmaz; operasyonel create/edit Yayın Planlama'dan) |
| `apps/web/src/app/features/schedules/schedule-detail/` | **DELETE** (detay eski schedule UI üstünden olmaz) |
| `apps/web/src/app/core/services/schedule.service.ts` | Eski haliyle restore **EDİLMEZ**; ya silinir ya da live-plan datasource wrapper'a refactor edilir (implementation tercihi) |
| `apps/web/src/app/features/schedules/reporting/` | KORUNUR (Y5-1 — reporting schedule canonical kalır) |
| `apps/web/src/app/features/schedules/schedules.routes.ts` | Refactor: root `''` → **schedule-list** (redirect YOK); `reporting` korunur; `new`/`:id`/`:id/edit` DELETE (form/detail yok) |
| `apps/web/src/app/app.component.ts` | "Canlı Yayın Plan" route `/schedules` (eski yer korunur; B5a Block 1'de `/live-plan`'a yapılan değişiklik **revert**) |
| `apps/web/src/app/app.routes.ts` | Wildcard `**` → `/schedules` (eski default; B5a Block 1'de `/yayin-planlama`'ya yapılan değişiklik **revert**) |
| `apps/web/src/app/features/dashboard/dashboard.component.ts` | ScheduleService bağımlılığı kaldırılır veya live-plan datasource'a refactor edilir (Y5-7 paritesi) |
| `apps/web/src/app/features/ingest/ingest-list/ingest-list.component.ts` | "Canlı Yayın Planından Ingest" panel B5a'da disabled (Y5-7 — ingest live_plan_entries.id bekler) — datasource swap sonrası `live_plan_entries`'ten besleyen yeni akış canonical (ayrı PR) |
| `tests/playwright/yayin-planlama.spec.ts` | Y5-1 yeni nav beklentisi: "Canlı Yayın Plan" → `/schedules` eski görünümlü ekran; network çağrısı `/api/v1/live-plan` |
| `tests/playwright` (yeni) | schedule-list datasource swap için "Canlı Yayın Plan listesi live-plan endpoint'i çağırır + boş/dolu render eski hisse" smoke testi |

### Y5-4 — Backend cleanup (B5a Block 1'de yapıldı; ikinci revize 2026-05-08 — datasource migration ışığında durum)

**Karar**: Aşağıdaki backend değişiklikleri **B5a Block 1'de yapıldı (commit 23ef5f4 + 4b9430b)** ve **korunur** — Canlı Yayın Plan UI artık live-plan endpoint'inden okur, legacy schedule CRUD'a ihtiyacı yok.

| Path | Aksiyon | Durum |
|------|---------|-------|
| `apps/api/src/modules/schedules/schedule.routes.ts` | Legacy `GET /` (root list), `POST /`, `PATCH /:id`, `DELETE /:id`, `POST /import` **DELETE** | DONE — geri alınmaz; yeni UI bunları çağırmaz, live-plan endpoint okur |
| `apps/api/src/modules/schedules/schedule.routes.ts` | `GET /:id` korunur (yayin-planlama getById bağımlı) | DONE |
| `apps/api/src/modules/schedules/schedule.routes.ts` | `GET /export`, `GET /reports/live-plan*`, `GET /ingest-candidates` **canonical filter** (`eventKey IS NOT NULL`) | DONE |
| `apps/api/src/modules/schedules/schedule.schema.ts` | `createScheduleSchema`, `updateScheduleSchema`, `scheduleQuerySchema.usage` field DELETE | DONE |
| `apps/api/src/modules/schedules/schedule.service.ts` | `findAll(usage)`, `findById`, `create/update/remove` legacy method'lar DELETE; `attachIngestPorts` `usage_scope='live-plan'` filter kaldır | DONE |
| `apps/api/src/modules/schedules/schedule.import.ts` | Legacy BXF importer DELETE (Y5-6) | DONE |
| `apps/api/src/modules/schedules/schedule.export.ts` | Refactor: `start_time` order → `scheduleDate + scheduleTime`; `usage` query DELETE | DONE |
| `apps/api/src/modules/ingest/ingest.service.ts` | `usage_scope='live-plan'` coupling DELETE; `live_plan_entries.id` temelli (Y5-7) | DONE |
| `apps/api/prisma/schema.prisma` | `Schedule.usageScope` field + 2 `@@index` DELETE | DONE |
| `packages/shared/src/types/schedule.ts` | `Schedule.usageScope`, `ScheduleUsageScope`, `ScheduleUsage`, `CreateScheduleDto`, `UpdateScheduleDto` DELETE | DONE |
| Test'ler | Legacy spec'ler DELETE (`schedule.service.integration`, `schedule-opta-match-id`, `db-constraints` usage_scope CHECK testi, `ingest.service.integration` coupling); `schedule.broadcast-flow.integration` korunur | DONE |

**Not**: Backend cleanup datasource swap'tan bağımsız doğrudur — yeni schedule-list UI live-plan endpoint'i çağırır, legacy CRUD'a dokunmaz; reporting + export + broadcast + lookup + GET /:id korunur.

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

### §3.2 Backend changes (B5a Block 1'de DONE — 23ef5f4 + 4b9430b)

- `schedule.routes.ts`: legacy POST/PATCH/DELETE root + `/:id` DELETE; reports/export/ingest-candidates canonical eventKey filter — DONE
- `schedule.schema.ts`: legacy schemas DELETE — DONE
- `schedule.service.ts`: legacy methods DELETE; broadcast flow + lookup + reports korunur — DONE
- `schedule.import.ts`: DELETE — DONE
- `schedule.export.ts`: canonical alanlara refactor (start_time order → scheduleDate+scheduleTime; usage filter DELETE) — DONE
- **Reporting canonical uyumu** (§6.1): reporting datasource schedule canonical kalır (Y5-1); B5b'de canonical alanlara taşınır (UI + backend)
- `ingest.service.ts`: usage_scope coupling DELETE — DONE
- `schema.prisma`: `Schedule.usageScope` field + 2 `@@index` DELETE — DONE
- Prisma client regenerate — DONE
- Test'ler: legacy spec DELETE; broadcast flow + opta cascade + lookup spec'ler korunur — DONE

### §3.3 Frontend changes (ikinci revize 2026-05-08 — datasource migration)

**Restore + refactor**:
- `schedule-list/` **restore** (commit 0f62c3a / öncesinden) ve datasource live-plan API'ye taşı
- LivePlanEntry → SchedulePresentation mapper yaz (eski kolon hissi korunur)
- `core/services/schedule.service.ts` ya restore edip live-plan endpoint'ine refactor, ya da silip bileşeni `LivePlanService`/`ApiService` ile besle
- `dashboard.component.ts` ScheduleService bağımlılığı: live-plan datasource'a refactor veya restore
- `schedules.routes.ts` root path `''` → schedule-list (redirect YOK; B5a Block 1 redirect kararı **iptal**); `reporting` korunur; `new`/`:id`/`:id/edit` DELETE (form/detail yok)

**Revert (B5a Block 1'de yanlış uygulanmış)**:
- `app.component.ts` "Canlı Yayın Plan" route → `/schedules` (`/live-plan` revert)
- `app.routes.ts` wildcard `**` → `/schedules` (`/yayin-planlama` revert)

**Korunur (B5a Block 1'den)**:
- `schedule-form/`, `schedule-detail/` DELETE — restore EDİLMEZ (Y5-3)
- `usage_scope` kod dependency sıfırlama (frontend tip + bileşen ref'leri)
- `ingest-list.component.ts` "Canlı Yayın Planından Ingest" panel disabled (Y5-7 ingest live_plan_entries.id bekler)

**Playwright**:
- `tests/playwright/yayin-planlama.spec.ts` Y5-1 yeni beklenti: "Canlı Yayın Plan" → `/schedules` eski görünümlü ekran; network çağrısı `/api/v1/live-plan`
- Yeni smoke (opsiyonel): schedule-list datasource swap doğrulama (boş/dolu render, kolon hissi korunur)

### §3.4 Test impact (B5a Block 1'de DONE; ikinci revize ışığında)

- `schedule.service.integration.spec.ts`: legacy path DELETE — DONE
- `schedule-opta-match-id.integration.spec.ts`: legacy create body DELETE (canonical broadcast flow ayrı spec'te) — DONE
- `db-constraints.integration.spec.ts`: usage_scope CHECK testi DELETE — DONE
- `ingest.service.integration.spec.ts`: usage_scope coupling testi DELETE/refactor — DONE
- `schedule-list.component.spec.ts`: **restore + datasource mock güncel (live-plan)**
- `schedule.service.spec.ts` (frontend): restore veya silme (Y5-3 implementation tercihi)
- `schedule.broadcast-flow.integration.spec.ts`: korunur (DONE B3a)

---

## §4 — Test gates (commit/push öncesi zorunlu)

| Gate | Hedef |
|------|-------|
| Backend lint | EXIT=0 |
| Backend full integration | tüm spec'ler yeşil (B3a/B3b/B3c/B4-prep + lookup korunur) |
| Web typecheck (app + spec) | EXIT=0 |
| Karma component test | TÜMÜ yeşil (schedule-list datasource swap testleri yeşil) |
| Playwright chromium + mobile-chrome | yayin-planlama.spec.ts + Canlı Yayın Plan datasource swap smoke yeşil |
| Route smoke (manuel veya Playwright) | `/schedules` → eski görünümlü Canlı Yayın Plan (datasource live-plan); `/schedules/reporting` 200; `/live-plan` route 200 (M5 UI; nav'da görünmez); `/yayin-planlama` Yayın Planlama UI; wildcard → `/schedules` |
| Network smoke | "Canlı Yayın Plan" liste sayfası `/api/v1/live-plan` çağırır, **legacy `/api/v1/schedules` GET çağırmaz** |

---

## §5 — Migration runbook (Y5-7 backup + sıra)

### §5.1 Local docker compose runtime DB

**B5a Block 2 migration ayrı onaya tabidir** (Y5-2a — kolon DROP). Sıra:

1. **Backup zorunlu** (`pg_dump bcms` → `backups/bcms-runtime-before-b5-cleanup-<TARIH>.sql`)
2. Frontend datasource migration deploy (UI live-plan'dan okur; API legacy schedule CRUD silinmiş — yeni UI bunlara dokunmaz)
3. Smoke + Playwright **YEŞİL** olduktan SONRA Block 2 onayı iste
4. Block 2 onaylanınca: `prisma migrate deploy` (B5a migration `usage_scope` + `channel_id` + `deleted_at` kolon DROP)
5. Web + API container rebuild
6. Smoke: `/schedules` Canlı Yayın Plan eski hisse (datasource live-plan), `/schedules/reporting` 200, `/yayin-planlama`, `/live-plan` (route 200, nav'dan gizli)
7. Playwright koşum (chromium + mobile-chrome)
8. API log'da P2022 / undefined column kontrol — temiz olmalı

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

### §6.1 Reporting kapsamı (ikinci revize 2026-05-08: datasource ayrımı)

`/schedules/reporting` UI'sı **B5a'da kırılmaz** (Y5-1). Reporting **datasource schedule canonical kalır** — Canlı Yayın Plan UI datasource swap'ı reporting'i etkilemez. Reporting backend/frontend `metadata.contentName`/`metadata.houseNumber`/`start_time`/`end_time` kullanımı **B5b'ye taşındı**:

- **B5a**: reporting `usage_scope` filter'ı `eventKey IS NOT NULL` veya canonical filter'a refactor edilir (B5a Block 1'de DONE). `metadata.contentName/houseNumber/start_time/end_time` reporting'de **dokunulmaz** (kolonlar DURUR). Reporting datasource **schedule canonical** kalır; live-plan'a taşınmaz.
- **B5b**: reporting'in canonical alanlara tam taşınması:
  - `start_time` → `scheduleDate + scheduleTime` derive
  - `end_time` → yeni `event_end_time` kolonu **veya** `event_duration_min` ile derive **veya** UI'dan endTime kolon kaldırma (B5b başlangıcında karar)
  - `metadata.contentName` → yeni `content_name` kolon **veya** UI'dan kaldırma
  - `metadata.houseNumber` → yeni `house_number` kolon **veya** UI'dan kaldırma
- B5b'de smoke + Karma + Playwright yeşil olduktan **sonra** `metadata`/`start_time`/`end_time` DROP edilir.
- Ürün davranışı (rapor çıktıları, kolonlar) B5a'da **birebir korunur**; B5b'de canonical alanlardan beslenir; advanced reporting redesign ayrı PR.

**Önemli ayrım**: Canlı Yayın Plan liste sayfası (`/schedules`) datasource'u **live-plan API**; reporting (`/schedules/reporting`) datasource'u **schedule canonical**. İki UI aynı `/schedules` route prefix'i altında ama farklı backend kaynaklarından beslenir.

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
| 2026-05-08 (ikinci revize — UI delete iptal; datasource migration kararı) | Patron'un asıl talebi yanlış anlaşıldı: "Canlı Yayın Plan sekmesi arayüz hissi korunur, datasource live-plan API'ye taşınır" — route ve arayüz bir şey, datasource başka şey. **B5a Block 1'de yapılan yanlış kararlar iptal**: (a) "Canlı Yayın Plan → /live-plan" nav swap; (b) `/schedules` root → `/yayin-planlama` redirect; (c) wildcard → `/yayin-planlama`; (d) `schedule-list/` UI delete; (e) `core/services/schedule.service.ts` delete. **Yeni Y5-1**: "Canlı Yayın Plan" → `/schedules` (eski yer); schedule-list UI restore + datasource swap (LivePlanEntry → SchedulePresentation mapper); wildcard → `/schedules`; `/live-plan` route nav'dan gizli. **Yeni Y5-3**: schedule-list KORUNUR + datasource live-plan'a taşınır; schedule-form/schedule-detail DELETE (Canlı Yayın Plan B5a'da liste odaklı / read-only); operasyonel create/edit Yayın Planlama'dan. **Yeni Y5-4**: backend cleanup B5a Block 1'de DONE — datasource swap'tan bağımsız doğrudur (yeni UI live-plan endpoint'i çağırır, legacy CRUD'a dokunmaz). Reporting datasource schedule canonical kalır (Y5-1; B5b'de canonicalize). Block 2 migration ayrı onaya tabi. Production/cloud DB apply yok. |
