# Schedule/Yayın Planlama Cleanup V1 (SCHED-B5)

> **Status**: ✅ Locked (2026-05-08). Implementation gate for SCHED-B5 destructive cleanup.
> **Tarih**: 2026-05-08
> **Cross-reference**:
> - `ops/REQUIREMENTS-SCHEDULE-BROADCAST-FLOW-V1.md` (K-B3.1-K-B3.27)
> - `ops/REQUIREMENTS-SCHEDULE-OPTA-SYNC-V1.md` (KO1-KO14)
> - `ops/REQUIREMENTS-SCHEDULE-FRONTEND-V1.md` (Y4-1..Y4-10 + Y4-4 revize)
> - `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §3.5 K16

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

### Y5-2 — DB DROP NOW (kolonlar + ilişkili constraint/index)

**Karar**: Aşağıdaki kolonlar B5 migration'ında DROP edilir:

| Kolon | Sebep |
|-------|-------|
| `schedules.usage_scope` | discriminator artık modelde olmayacak; CHECK + 2 index DROP |
| `schedules.metadata` | JSON canonical değil; transStart/End/optaMatchId zaten kolon promote oldu |
| `schedules.start_time` | canonical `scheduleDate + scheduleTime` yeterli; legacy GiST exclusion ile DROP |
| `schedules.end_time` | aynı |
| `schedules.channel_id` | legacy single-channel; `channel_1/2/3_id` canonical; FK + index DROP |
| `schedules.deleted_at` | hard-delete domain (B5 sonrası schedule soft-delete YAPILMAZ); index DROP |

**Legacy row DELETE**:
- Filter: `event_key IS NULL OR usage_scope='live-plan'` (132 row; 0 FK cascade impact)
- Migration sırası: row delete → constraint drop → index drop → column drop

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

### §3.1 DB migration (yeni Prisma migration dosyası)

```sql
-- 1. Legacy row DELETE (cascade FK 0 impact)
DELETE FROM schedules WHERE event_key IS NULL;

-- 2. Constraint DROP
ALTER TABLE schedules DROP CONSTRAINT schedules_usage_scope_check;
ALTER TABLE schedules DROP CONSTRAINT schedules_no_channel_time_overlap;
ALTER TABLE schedules DROP CONSTRAINT schedules_channel_id_fkey;

-- 3. Index DROP
DROP INDEX schedules_usage_scope_idx;
DROP INDEX schedules_usage_scope_report_league_report_season_report_we_idx;
DROP INDEX schedules_channel_id_start_time_end_time_idx;
DROP INDEX schedules_deleted_at_idx;

-- 4. Column DROP
ALTER TABLE schedules
  DROP COLUMN usage_scope,
  DROP COLUMN metadata,
  DROP COLUMN start_time,
  DROP COLUMN end_time,
  DROP COLUMN channel_id,
  DROP COLUMN deleted_at;
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

### §6.1 Reporting kapsamı netleştirme

`/schedules/reporting` UI'sı **B5'te korunur** (Y5-1). Ancak reporting backend/frontend **DROP edilecek kolonlara (`usage_scope`, `start_time`, `end_time`, `metadata`, `deleted_at`) bağlı ise B5 implementation içinde canonical uyuma refactor edilir** — drop migration kullanıcının raporlama akışını kırarak teslim edilemez.

- Implementation öncesi reporting dependency inventory zorunlu (`schedule.routes.ts:170-282` `/reports/live-plan*`, `schedule.export.ts`, `reporting/schedule-reporting.component.ts`, vb.).
- Refactor kapsamı: legacy alanları **canonical karşılıklarına bağla** (örn. `start_time` → `scheduleDate + scheduleTime`, `usage_scope='live-plan'` → `event_key IS NOT NULL`).
- Ürün davranışı + rapor çıktıları **birebir korunur** (kullanıcı algı süreklilik); UI redesign B5 dışı follow-up.

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
