# Backend Canonical Data Model V1

> **Status**: Draft (2026-05-09).
> Bu doküman BCMS backend tarafında domain canonical DB modelinin yönelimini
> ve fazlamasını tespit eder. Implementation gate'i onaylanmadan migration
> yazılmaz; production/cloud DB'ye uygulanmaz.

## 1. Amaç

BCMS backend'de domain bilgileri (event, schedule, ingest, studio, booking)
**JSON metadata yerine structured DB kolonları + model ilişkileri** üzerinden
canonical olarak tutulur. Audit/outbox/external-payload JSON kullanımı
istisnadır; domain canonical sayılmaz.

Hedef:
- Reporting/aggregation tutarlılığı
- Referential integrity (FK + cascade)
- Optimistic locking + concurrent worker güvenliği
- Cross-domain coupling'ı scalar string match yerine FK üzerinden ifade etme

## 2. Canonical DB İlkeleri

1. **Structured kolon canonical**: domain karar alanı (status, FK, tarih,
   isim) JSON metadata içinde değil, structured kolonda yaşar.
2. **FK + cascade explicit**: cross-domain referans Prisma `@relation` ile
   tanımlanır; `onDelete` davranışı (Cascade / SetNull / Restrict) açık.
3. **Master data ayrı tablo**: free-form VARCHAR yerine catalog tablo + FK
   (örn. Studio, Channel, Program). Soft string match kabul değil.
4. **Optimistic locking**: domain entity'lerinde `version Int @default(1)`;
   PATCH/PUT If-Match enforce.
5. **JSON kullanımı yalnızca**: audit log, outbox payload, integration raw
   payload (ör. OPTA / FFmpeg QC), Channel mux config (DVB params; ayrı
   karar). Domain karar alanı JSON'da yer almaz.
6. **Soft-delete ilkesi (BCMS kararı 2026-05-09)**:
   - **Raporları etkileyen operasyonel domain kayıtlarında hard-delete
     tercih edilir.** Soft-delete operasyonel raporlara sızıp yanlış
     sayı/aggregation üretme riski taşır.
   - **Bu yüzden `Schedule`, `LivePlanEntry`, `IngestJob`, `IngestPlanItem`,
     `StudioPlanSlot`, `Booking` gibi operasyonel kayıtlar için default
     soft-delete yok.**
   - Bu kayıtlarda yaşam döngüsü gerekiyorsa **status alanı** kullanılır:
     `CANCELLED` / `COMPLETED` / `FAILED` / `ARCHIVED` vb.
   - Silinmesi gereken test/operasyonel kayıt **hard-delete** edilir.
   - **Lookup/master data için soft-delete kullanılabilir**: `Channel`,
     `Studio`, `Program`, `Color`, `RecordingPort`, lookup option tabloları
     (commercial/logo/format option, transmission lookups, vb.) gibi.
   - Lookup soft-delete raporlara **doğrudan satır olarak girmemeli**;
     sadece geçmiş FK anlamını korumalı. Aktif kayıt listelemelerinde
     `deletedAt IS NULL` filter uygulanır.
   - `Schedule.deleted_at` canonical değil; legacy/drop candidate.
   - **Her tabloya `deletedAt` ekleme yaklaşımı yasak.** Yeni model
     eklerken default soft-delete eklenmez; ihtiyaç ayrı karar.
7. **Discriminator yerine FK**: composite string key (`live:day:loc:min:title`)
   yerine `sourceType` enum + structured FK (sourceType=live → liveplanEntryId).

## 3. Domain Canonical Kaynak Matrisi

| Domain | Canonical kaynak | Coupling |
|--------|------------------|----------|
| Canlı Yayın Plan | `LivePlanEntry` (+ TechnicalDetail + Segment) | OPTA Match (FK SetNull); IngestJob.targetId (FK SetNull, Faz A1) |
| Yayın Planlama (broadcast) | `Schedule` (event_key UNIQUE + 3-channel slot + 3-lookup FK) | LivePlanEntry (eventKey reverse propagation; selectedLivePlanEntryId scalar) |
| Reporting | `Schedule` canonical alanlar (Faz C sonrası) | metadata bağımlılığı kaldırılır |
| Ingest planı | `IngestPlanItem` (sourceKey UNIQUE; sourceType enum Faz A5) | jobId → IngestJob (Cascade); discriminator FK (Faz dışı follow-up) |
| Ingest job | `IngestJob` (targetId relation Faz A1; planItemId FK Faz A2; version Faz A3) | targetId → LivePlanEntry (SetNull) |
| Stüdyo planı | `StudioPlan` + `StudioPlanSlot` (studioId/programId FK Faz B) | StudioPlanProgram, Studio (yeni master) |
| Bookings | `Booking` (taskTitle/Details/assignee/dates structured) | scheduleId → Schedule (Cascade); metadata transient |
| Incidents | `Incident` (eventType structured) | scheduleId → Schedule (Cascade); metadata transient |
| Weekly Shift | **Açık karar** — Keycloak attribute (mevcut) veya ShiftAssignment Prisma | Faz B5 |
| Audit | `AuditLog` (Json payload) | beklenen JSON |
| Outbox | `OutboxEvent` (Json payload) | beklenen JSON |

## 4. Ingest Faz A Sıralaması (revize 2026-05-09)

Patron emir: "A4 metadata DROP, A2 tamamlanmadan önerilemez." Doğru sıra:

### A1 — `IngestJob.targetId` Prisma relation

- Mevcut: scalar FK; manuel `findFirst` doğrulama (Y5-7).
- Hedef: `livePlanEntry LivePlanEntry? @relation(fields:[targetId], references:[id], onDelete:SetNull)`.
- Migration: `ALTER TABLE ingest_jobs ADD CONSTRAINT ingest_jobs_target_id_fkey FOREIGN KEY (target_id) REFERENCES live_plan_entries(id) ON DELETE SET NULL`.
- Pre-migration kontrol: orphan satır inventory (`SELECT id, target_id FROM ingest_jobs WHERE target_id NOT IN (SELECT id FROM live_plan_entries)`).
- Service: `triggerManualIngest` early validation korunur (400 explicit error); FK orphan handle SetNull.
- Test: A1 cascade integration spec.
- UI etkisi: yok.
- Risk: production'da orphan satır varsa ADD CONSTRAINT fail; pre-clean adımı zorunlu.

### A2 — `IngestJob.planItemId` structured FK + `metadata.ingestPlanSourceKey` backfill

- Mevcut: `IngestJob.metadata.ingestPlanSourceKey` (string) — `IngestPlanItem.sourceKey` forwarding (transient plan link).
- Hedef:
  - `IngestJob.planItemId Int?` direkt FK → `IngestPlanItem.id` ON DELETE SET NULL (veya CASCADE — açık karar; yan etki: plan item silinince job orphan vs deleted)
  - `IngestPlanItem.jobId` mevcut reverse FK kalır
- Migration: ADD COLUMN + backfill (`UPDATE ingest_jobs SET plan_item_id = (SELECT id FROM ingest_plan_items WHERE source_key = ingest_jobs.metadata->>'ingestPlanSourceKey')`).
- Service: `triggerManualIngest` `dto.metadata.ingestPlanSourceKey` yerine `dto.planItemId` parametresi alır (DTO breaking; route layer destek için backward compat opsiyonu).
- Test: A2 backfill integration spec.
- UI etkisi: minor — frontend triggerManualIngest çağrı parametresi değişebilir; mevcut "Manuel Ingest Başlat" form'u sourceKey bilmediği için zaten metadata gönderemez.
- Risk: backfill plan item silinmiş kayıtlar için NULL kalır; manuel review gerekebilir.

### A3 — `IngestJob.version` optimistic locking

- Mevcut: yok (Schedule/Booking/LivePlan'da var).
- Hedef: `version Int @default(1)`.
- Migration: ADD COLUMN default 1.
- Service: `processIngestCallback` + `finalizeIngestJob` `updateMany` + version increment + If-Match (callback contract için opsiyonel; worker internal kullanır).
- Test: A3 concurrent terminal status race spec.
- UI etkisi: yok.
- Risk: external worker callback kontratı If-Match header eklenirse ayrı koordinasyon (Avid capture tarafı).

### A4 — `IngestJob.metadata` DROP — **DONE 2026-05-10**

- Önkoşul (sağlandı): A2 PR-2c production-role'de yerleşik; runtime grep `sourceKey` no match; PR-2b post-validation `null_fk_matchable=0` + `metadata_only_after_pr2a=0`.
- Build-phase notu (2026-05-10): proje hâlâ inşa aşamasında; ingest_jobs içindeki veriler operasyonel olarak önemsiz. 7 günlük gözlem süresi atlandı; observation runbook bu PR'da silindi.
- Migration: `20260510000000_drop_ingest_job_metadata` — `ALTER TABLE ingest_jobs DROP COLUMN metadata`.
- Service: `dto.metadata` field + `Prisma.InputJsonValue` cast + create payload `metadata` kaldırıldı. Zod `createIngestSchema.metadata` kaldırıldı.
- Shared: `CreateIngestJobDto.metadata` kaldırıldı. `IngestJob.metadata` **geçici compatibility için optional korundu** (`@deprecated` JSDoc); frontend cleanup PR'ı atılana kadar; backend persiste/return etmiyor.
- Frontend: bu PR `apps/web` altında değişiklik içermiyor. `ingest-list.component.ts:425` `j.metadata?.['scheduleTitle']` referansı runtime'da `undefined` döner ve `'#' + j.targetId` fallback'i devreye girer (kozmetik regresyon kabul). Disabled `triggerLivePlanJob()` panel + state alanı cleanup ayrı follow-up PR'da.
- Backfill artifact'leri (`apps/api/src/scripts/backfill-ingest-plan-item-id.*`, `prisma-factory.ts`, `package.json` entry, `ops/runbooks/A2-PR2B-INGEST-PLAN-ITEM-BACKFILL.md`): silindi. Tarihçe git history (PR-2b commit `438fa09`) üzerinden ulaşılabilir.
- Observation runbook (`ops/runbooks/A4-INGEST-METADATA-DROP-OBSERVATION.md`): silindi (gözlem atlandığı için).
- Test: 3 metadata-only test silindi; spec başlığı revize.
- Risk: data kaybı kalıcı (build-phase'de etkisiz).

### A5 — `IngestPlanItem.sourceType` canonical literal set — **DONE 2026-05-10**

- Önkoşul (sağlandı): pre-inventory `SELECT DISTINCT source_type` 4 canonical değer döndü
  (live-plan: 50, studio-plan: 17, ingest-plan: 2, manual: 1) — 0 invalid satır,
  0 NULL/empty.
- **Native Prisma enum YERİNE Postgres CHECK + Zod enum + shared literal union**
  seçildi. Sebep: Prisma enum identifier kebab-case desteklemez (UPPER_SNAKE
  gerektirir); enum'a geçiş wire format'ı `live-plan` → `LIVE_PLAN` yapardı,
  bu hem mevcut 70 satırın UPDATE'ini hem de **frontend literal'lerinin
  değişmesini** gerektirirdi. Karar: kebab-case wire format korunsun;
  frontend (`apps/web`) dokunulmasın.
- Migration: `20260510000001_ingest_plan_item_source_type_check` —
  `ALTER TABLE ingest_plan_items ADD CONSTRAINT ingest_plan_items_source_type_check
  CHECK (source_type IN ('live-plan', 'studio-plan', 'ingest-plan', 'manual'))`.
- Service: `ingest.routes.ts` `sourceTypeSchema = z.enum(['live-plan', 'studio-plan',
  'ingest-plan', 'manual'])` (export); `savePlanItemSchema.sourceType` Zod enum.
- Shared: `IngestPlanItemSourceType` type alias; `IngestPlanItem.sourceType` ve
  `SaveIngestPlanItemDto.sourceType` strict literal union (`| string` fallback
  kalktı).
- Test: A5 regression bloğu (canonical 4 Prisma create kabul + Zod safeParse
  accept/reject + DB CHECK reject + PUT plan upsert regression).
- Test DB helper: `applyIngestPlanItemSourceTypeConstraint` (db push CHECK'i
  tüketmiyor; setup'ta reapply).
- UI etkisi: **yok** (`apps/web` dokunulmadı; mevcut kebab-case literal'ler
  daralmış union'a uyumlu).
- Risk: yok (build-phase, 0 invalid satır, frontend kontrat değişmedi).

## 5. Studio Faz B (Plan)

UI etkisi olduğu için **hemen implementation YOK**; plan olarak doküman.

### B1 — Yeni `Studio` master tablo

- `model Studio { id PK / name UNIQUE / sortOrder / active / soft-delete (lookup-uygun) }`
- Seed: mevcut distinct `studio_plan_slots.studio` → normalize edilmiş master.

### B2 — `StudioPlanSlot.studio` → `studioId FK`

- Backfill: distinct string → studioId mapping (Türkçe çeşitlemeleri normalize: "Stüdyo 1" / "Studio 1" / "Studio-1").
- Migration: ADD `studio_id` + backfill + DROP `studio` VARCHAR.
- UI: studio dropdown master'dan; manuel string yazım kapatılır.

### B3 — `StudioPlanSlot.program` → `programId FK` (`StudioPlanProgram`)

- Mevcut: soft string match.
- UI: dropdown zaten catalog'tan; backend FK eklenmiş olur.

### B4 — `StudioPlanSlot.status` (StudioPlanSlotStatus enum) — açık karar

- Operasyonel takip için (PLANNED/LIVE/COMPLETED/CANCELLED).
- Karar gerek: bu alan ürün ihtiyacı mı? (mevcut UI'da "tamamlandı" işareti yok)
- Not: §2/6 ilkesine göre operasyonel domain'de soft-delete yerine status —
  bu alan `StudioPlanSlot` lifecycle için canonical olur.

### B5 — `ShiftAssignment` ne olacak — açık karar

- (a) Tablo + Prisma model SİL (kod kullanmıyor; Keycloak attribute canonical)
- (b) WeeklyShift route DB'ye taşı (Keycloak'tan ShiftAssignment'a)
- Patron kararı gerek.

**UI etkisi**: B2 (studio dropdown) + B4 (status badge) + B5 (Keycloak'tan DB'ye taşıma) — ayrı onay turlarında değerlendirilir.

## 6. Reporting Faz C

Mevcut lock: `ops/REQUIREMENTS-SCHEDULE-CLEANUP-V1.md` §6.1 (B5b).

### C1 — Reporting datasource canonical alanlara taşı

- `Schedule.metadata.contentName` → yeni `content_name VARCHAR(500)` **veya** UI kolonu kaldır
- `Schedule.metadata.houseNumber` → yeni `house_number VARCHAR(50)` **veya** kaldır
- `Schedule.start_time` → `scheduleDate + scheduleTime` derive
- `Schedule.end_time` → yeni `event_end_time TIMESTAMPTZ` **veya** `event_duration_min INT` derive **veya** UI'dan kaldır

### C2 — Reporting backend + frontend refactor

- `schedule.routes.ts:/reports/live-plan*` + `schedule.export.ts` → canonical alanlardan
- `apps/web/src/app/features/schedules/reporting/` → field binding refactor

**UI etkisi**: var (B5b lock'lu kabul).

## 7. Hard Drop Faz D

**Önkoşul**: Faz A1-A3 + A4 + Faz C tamamlandıktan sonra.

**DROP CANDIDATE**:
- `Schedule.metadata` (Faz C sonrası)
- `Schedule.start_time` (Faz C sonrası)
- `Schedule.end_time` (Faz C sonrası)
- `Schedule.usage_scope` (B5a Block 2 — zaten ayrı onayda)
- `Schedule.channel_id` (B5a Block 2)
- `Schedule.deleted_at` (B5a Block 2; §2/6 ilkesine uygun — operasyonel
  domain'de canonical değil)
- `Schedule.content_id` DROP CANDIDATE (Y5-8)
- `Schedule.broadcast_type_id` DROP CANDIDATE (Y5-8)
- `IngestJob.metadata` DROP (A4 — Faz A içinde sayılır)
- `ShiftAssignment` tablo DROP (B5 — eğer "SİL" kararı verilirse)

**REVIEW REQUIRED (drop candidate DEĞİL)**:
- `Schedule.finished_at` — reporting veya broadcast completion için
  kullanılıyor olabilir; preflight bunu yeterince kanıtlamadı. Drop
  öncesi ayrı inventory: hangi raporlar/endpoint'ler okuyor; canonical
  alternative (`Schedule.status='COMPLETED'` veya yeni `completed_at`)
  yeterli mi?

**Migration**: DROP COLUMN/TABLE; rollback için backup zorunlu; data kaybı kalıcı.

## 8. JSON Kalabilir / Kalamaz Matrisi

### Kalabilir (canonical değil; teknik kullanım)

| Alan | Sebep |
|------|-------|
| `AuditLog.beforePayload`, `AuditLog.afterPayload` | audit row snapshot |
| `OutboxEvent.payload` | event envelope; consumer parse |
| `QcReport.errors`, `QcReport.warnings` | external FFmpeg/QC raw payload |
| `League.metadata`, `Team.metadata` | OPTA sync raw payload (integration kabul) |
| `Booking.metadata` | transient create/update; backend okumuyor; 16KB cap |
| `Incident.metadata` | transient report-issue; backend okumuyor |
| `Channel.muxInfo` | DVB params; structured ayrılması ayrı PR (kapsam dışı) |

### Kalamaz / structured'a taşınacak

| Alan | Hedef faz |
|------|-----------|
| `Schedule.metadata` (`contentName`, `houseNumber`, `transStart`, `transEnd`, `liveDetails`, `optaMatchId`) | Faz C → Faz D DROP |
| `IngestJob.metadata.ingestPlanSourceKey` | Faz A2 → Faz A4 DROP |

## 9. Açık Kararlar

1. **`ShiftAssignment` SİL mi taşı mı?** (Faz B5 — patron kararı)
2. **`Studio` master tablo eklenecek mi?** (Faz B1 — patron kararı; bu doküman varsayılan: evet)
3. **`StudioPlanSlot.status` field gerekiyor mu?** (Faz B4 — patron kararı)
4. **`IngestJob.planItemId` cascade davranışı**: SetNull mu Cascade mı? (Faz A2 onayında)
5. **`Schedule.match_id` vs `LivePlanEntry.match_id`**: çift FK; hangisi kanonik? (Faz C / D incelemesinde)
6. **`Booking.metadata` strict tipleme**: kalsın mı, kaldırılsın mı? (mevcut: kalsın)
7. **`Channel.muxInfo` JSON structured'a ayrılsın mı**? (kapsam dışı; ayrı PR)
8. **`Schedule.finished_at` review**: hangi kullanım canonical alternative ile karşılansın? (Faz D öncesi inventory)
9. **A4 ile A5 sırası**: A4 (metadata DROP) öncelikli; A5 (sourceType enum) sonrasında çalışılabilir veya bağımsız sıralanabilir.

## 10. Implementation Gate Kuralları

1. **Doküman onayı** olmadan migration yazılmaz.
2. **Her faz ayrı gate**: Faz A için A1 → A2 → A3 → A4 → A5 sıralaması; her adım ayrı PR + ayrı onay.
3. **Pre-migration inventory**: orphan satır / distinct value sayımı; raporlanır.
4. **Backfill stratejisi**: ADD COLUMN + UPDATE + (gerekirse) DROP — aynı PR'da değil; ayrı PR'larda (data güvenlik).
5. **Test ihtiyacı**: her faz için integration spec öncelik; UI etkilenirse Karma + Playwright ek.
6. **Rollback runbook**: DROP COLUMN/TABLE öncesi pg_dump backup; rollback SQL hazır.
7. **Production/cloud DB apply**: bu doküman **YOK**. Local docker compose runtime DB üzerinde test; production deploy ayrı runbook + ayrı onay.
8. **UI değişikliği gerektiren işler ayrı onay**: Faz B (studio dropdown), Faz C (reporting), B5 (weekly-shift kararı) — UI etkisi olduğu için ayrı onay turunda değerlendirilir.

## 11. Production / Cloud DB

**Bu doküman production / cloud DB'ye uygulanmaz**. Sadece kararname + plan
seviyesindedir. Production deploy için:
- Production-grade backup (point-in-time recovery + offsite)
- Maintenance window planı
- Migration sırası (her faz için ayrı runbook)
- Rollback plan (data kaybı kalıcı kolon DROP'larında)
- Açık kullanıcı onayı (her aşama)

## 12. Review History

| Tarih | Yorum |
|-------|-------|
| 2026-05-09 | Draft. Ingest Faz A sırası A1→A2→A3→A4→A5 olarak revize. Studio Faz B plan-only (UI etkisi nedeniyle implementation ayrı onay). Reporting Faz C mevcut B5b lock'lu kapsam. Hard Drop Faz D Faz A-C tamamlandıktan sonra. JSON kalabilir/kalamaz matrisi. 9 açık karar listelendi. **Soft-delete ilkesi (§2/6) BCMS kararı 2026-05-09 ile netleştirildi**: operasyonel domain hard-delete; lifecycle status alanı; lookup/master data soft-delete uygun; her tabloya deletedAt ekleme yasak. **`Schedule.finished_at` (§7) drop candidate listesinden çıkarıldı, "review required" olarak işaretlendi** — preflight kullanım kanıtı yetersiz; Faz D öncesi ayrı inventory. |
