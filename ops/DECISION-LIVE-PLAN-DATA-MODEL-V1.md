# Live-Plan Data Model — Karar Notu

> **Status**: 🟢 14 karar locked + 1 open closed + 1 deferred (2026-05-06); M5-A doc implement edildi. Schema PR'ları (M5-B1+) deferred decision (sourceType cleanup) M5-B6/B7'de ele alınacak; başka blocker yok.
> **Tarih**: 2026-05-06
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 5 (skip listesi); finding 3.2.2 (severity revize §7) + 3.1.4 + yeni bulgu (schedule.content_id orphan §7).
> **Önceki versiyon**: Bu doc'un ilk taslağı `channel_id NULL = data quality bug` varsayımıyla yazılmıştı; o varsayım kullanıcı domain açıklamasıyla **reddedildi**. Bu sürüm o varsayımı içermez.

---

## §0 — Özet & Status

### 0.1 Karar yönü

`schedules` tablosu iki ayrı domain entity'i tek tabloda taşıyor:
- **Broadcast slot + reporting context** (canonical schedule).
- **Operasyon üst planı / event içerik organizasyonu** (canonical live-plan).

İkincisi `schedules` tablosundan çıkarılıp **kendi tablosuna** (`live_plan_entries`) taşınır. Bu değişiklik strangler yaklaşımıyla aşamalı yapılır (§5).

### 0.2 Status sınıflandırması

| Sınıf | Sayı | Detay |
|---|---|---|
| ✅ Locked (architectural) | 14 | §3 |
| ✅ Locked (M5-B1 scope) | K1-K6 | §3.2 — field/index set + out-of-scope |
| ✅ Locked (M5-B2 scope) | K7-K14 | §3.3 — route/DTO/If-Match/audit/soft delete/outbox shadow/RBAC/response |
| ✅ Closed | 1 | §4.1 — Booking semantic (local dev DB inventory 2026-05-06: 0 satır) |
| ⏸️ Deferred | 1 | §4.2 — `sourceType`/`sourceKey` cleanup timing |
| ✅ Inventory done | 3 SQL | §6 — local dev DB üzerinde çalıştırıldı (sonuçlar §6.4) |

### 0.3 channel_id NULL hakkında düzeltme

`schedules.channel_id IS NULL` **bug değil**, workflow state. Audit 3.2.2'nin severity'si `[ÖNEMLİ]` → `[BİLGİ]` revize edilmeli (§7). Asıl problem channel_id'nin NULL olması değil, **iki domain'in tek tabloda yaşıyor olması**.

---

## §1 — Domain Glossary

Bu glossary doc içinde her kavram için **tek tanım kaynağı**. PR review'larında ve kod yorumlarında bu terimlere referans verilir.

### Schedule

> **Yayın akışı / publication plan.**
>
> "Bu içerik hangi kanalda, hangi saatte yayınlanacak?" sorusunun cevabı.

- Canlı yayın da olabilir, bant da olabilir.
- Channel **opsiyonel**: yayın akışı kurgu aşamasında channel henüz atanmamış olabilir; bu workflow state'tir, bug değildir.
- Reporting context buradan türetilir: `report_league`, `report_season`, `report_week_number`, `match_id`.
- Channel-time overlap (DB GIST exclusion) channel atandıktan sonra geçerli.

**Tablo**: `schedules` (mevcut; M5'te kapsam daralır — live-plan satırları çıkar).

### Live-plan

> **Operasyon üst planı / event ve içerik organizasyonu.**
>
> "Bu event için ne planlıyoruz, hangi operasyonel bilgileri tutuyoruz?" sorusunun cevabı.

- OPTA'dan manuel/yarı-manuel alınan event bilgisinin üzerine operasyon bilgisi ekleyerek organize eder.
- Canlı event veya bant içerik üretebilir (her ikisi de).
- Channel merkezli **değil**; event/operasyon merkezli.
- Port allocation **buraya ait değil** (ingest-plan'da yaşar — locked decision §3.11).

**Tablo**: `live_plan_entries` (M5-B1'de oluşturulacak yeni tablo).

### Studio-plan

> **Haftalık stüdyo program matrisi.**
>
> "Bu hafta hangi stüdyoda hangi programlar çekiliyor?" sorusunun cevabı.

- Mevcut: `StudioPlan` (haftalık) + `StudioPlanSlot` (gün × stüdyo × dakika × program).
- Live-plan ile **paralel ama farklı** bir üst plan tipi (etkinlik değil, stüdyo programı).
- ingest-plan'ı besleyebilir (sourceType='studio-plan').

**Tablo**: `studio_plans` + `studio_plan_slots` (mevcut, değişmez).

### Ingest-plan

> **Kayıt icra planı / recording execution plan.**
>
> "Hangi kaynaktan, hangi portla, hangi saatte, hangi isimle kayıt yapacağız?" sorusunun cevabı.

- Live-plan, studio-plan veya manuel kaynaklardan beslenir.
- Port + day + minute range constraint authoritative burada (`ingest_plan_item_ports` GIST exclusion).
- Aynı live-plan entry'den birden fazla ingest item üretilebilir (örn. maç önü/maç/maç sonu).

**Tablo**: `ingest_plan_items` + `ingest_plan_item_ports` (mevcut; M5-B3/B4'te FK kolonları eklenir).

### Asset / Content (YOK)

> **Schema'da formal varlık tanımlı değil.**

- `schedule.content_id Int?` orphan kolon — hiçbir tabloya FK değil.
- Recordings sadece `ingest_jobs.proxy_path` (string) + `qc_reports` ile yaşıyor.
- Bant içerik workflow'u: live-plan → ingest-plan → kayıt dosyası → schedule (manuel link, formal entity yok).

**M5 etkisi**: Asset entity'si M5 scope'unda **yaratılmıyor**; lineage V2 asset modeli pre-req olarak işaretlendi (§3.12). schedule.content_id ayrı triage (§7).

---

## §2 — Read-Only Inventory

A1/A2 ve önceki investigation bulguları.

### 2.1 schedules tablosu mevcut durum

`apps/api/prisma/schema.prisma:92-135`:
- `channel_id Int? @map("channel_id")` — nullable
- `usage_scope String @default("broadcast") @db.VarChar(30)`
- DB CHECK constraint (`migrations/20260422000002`): `usage_scope IN ('broadcast', 'live-plan')`
- GIST exclusion (`migrations/20260429020000`): partial — `WHERE channel_id IS NOT NULL AND status <> 'CANCELLED'`

Canlı DB (audit 3.2.2 snapshot): 132 satır; ~129 channel_id NULL + usage_scope='live-plan'; ~3 channel_id NOT NULL + usage_scope='broadcast'. Tamamı test data.

### 2.2 schedule.service.ts overlap akışı

`schedule.service.ts:171-191`:
```ts
if (dto.channelId != null) {
  const conflicts = await tx.schedule.findMany({...});
  if (conflicts.length > 0) throw 409;
}
```

`channelId NULL` path için **service-level overlap kontrolü yok** — bu **kabul edilebilir**, çünkü:
- Live-plan kendi domain'inde overlap'i `ingest_plan_item_ports`'ta enforce ediyor (port-bazlı GIST).
- Schedule (broadcast) için channel atanmadan overlap kavramı zaten boş.

### 2.3 ingest_plan_items sourceType (polymorphic-string)

`schema.prisma:201`: `sourceType String @db.VarChar(30)`.
Kod kullanımı (string discriminator değerleri):
- `'ingest-plan'`
- `'manual'`
- `'live-plan'`
- `'studio-plan'`

Schema-level FK **yok**. `sourceKey String VarChar(500)` ad-hoc identifier; referential integrity kayıp.

### 2.4 StudioPlan canonical model

`schema.prisma:316-345`: `StudioPlan` (weekStart unique + version) + `StudioPlanSlot` (planId FK + dayDate/studio/startMinute/program/color).

Ingest ile bağ: **schema-level YOK**; ingest_plan_items.sourceType='studio-plan' string + sourceKey üzerinden implicit.

### 2.5 schedule.content_id orphan

- Schema'da `Content` veya `Asset` modeli **yok**.
- `schedule.content_id Int?` kolonu var ama FK değil; `@relation` hiçbir yere işaret etmiyor.
- Zod accepted; service write-through; web pass-through; **iş mantığı yok**.
- **Yeni audit finding kategorisinde** (M5 dışı).

### 2.6 Booking ↔ Schedule

`schema.prisma:142-171`:
```
model Booking {
  scheduleId Int? FK → Schedule.id (onDelete: Cascade)
  ...
}
```

129 test live-plan schedule satırına bookings bağlı **olabilir**. Cleanup öncesi inventory zorunlu (§6.3).

---

## §3 — Locked Decisions (14 madde)

| # | Karar | Gerekçe |
|---|---|---|
| 1 | `schedules.channel_id IS NULL` **bug değil**, workflow state. | Kanal yayın akışı kurgu aşamasında atanmamış olabilir; live-plan kanal-merkezli değil; bant içerik kanaldan bağımsız üretilebilir. |
| 2 | **`live_plan_entries` canonical üst entity** (yeni tablo). | Operasyon üst planı schedule'dan ayrılır; ingest_plan_items zaten alt-execution entity'si. |
| 3 | **`ingest_plan_items` execution entity** kalır. | Live/studio/manual kaynaklı kayıt icrası. Port allocation burada authoritative. |
| 4 | **Polymorphic FK yok**; `dual nullable FK + XOR CHECK` (`live_plan_entry_id` + `studio_plan_slot_id`). | RI loss kabul edilemez; iki kaynak limited; XOR + manual=NULL/NULL pattern doğru. |
| 5 | **Schedule ↔ live-plan V1'de FK'siz bağımsız.** | Domain'ler zaten farklı; lineage V2; bant içerik için weak operational link yeterli. |
| 6 | **Status enum'ları ayrı.** | DRAFT/CONFIRMED/ON_AIR/COMPLETED/CANCELLED (schedule) vs PLANNED/READY/RECORDING/COMPLETED/CANCELLED gibi (live-plan) — lifecycle farklı; shared enum domain coupling yaratır. |
| 7 | **Schema PR parçalı** (M5-B1...B6). | Tek-shot büyük schema PR review/test/rollback maliyeti yüksek; her aşama bağımsız production deploy. |
| 8 | **Eski `schedules.usageScope='live-plan'` satırları test data — cleanup, migration shim yok.** | Sistem inşa aşamasında, kullanıcı teyidi 2026-05-06; production data değil; backwards-compat shim gereksiz. |
| 9 | **`usageScope` kolonu kalır**, anlamı yeniden dokümante edilir. | Hemen rename düşük değerli churn; ileride yeni publication tipleri (replay, simulcast) için discriminator olarak kullanılabilir. |
| 10 | **Schedule kaldırılmaz**; broadcast slot + reporting context olarak daraltılır. | Yayın akışı bağımsız domain; reports/booking/timeline bağlı; live-plan ile aynı yere düşmez. |
| 11 | **Live-plan port taşımaz**; port allocation `ingest_plan_items` (ve port child tablosu) authoritative. | Port = "kayda girme kararı" özelliği, event'in özelliği değil; aynı event 3 farklı portta kayıt olabilir. UI live-plan ekranında "bağlı ingest portları" gösterilir, model'i bozmaz. |
| 12 | **Asset/Content entity yok**; M5 scope'unda yaratılmıyor. Lineage V2 = asset modeli pre-req. | `schedule.content_id` orphan; bant içerik workflow'unda formal asset olmaması M5 dışı genel bir gap. |
| 13 | **StudioPlan canonical model** (haftalık matrix); ingest bağı M5-B4'te formalize edilir. | Schema-level FK yok şu an; sourceType + sourceKey string discriminator; FK formalization sourceType='studio-plan' inventory sonrası. |
| 14 | **schedule.content_id ayrı triage** (M5 dışı). | Orphan kolon, yarım kalmış tasarım veya external system reference; M5'in domain modeli netleştikten sonra ayrı bir audit triage'a girer (rename / drop / FK ekle). |

### 3.1 XOR CHECK timing

Locked decision #4 dual FK kararı; **XOR CHECK ekleme zamanı** locked değil — pratik olarak:
- M5-B3: `live_plan_entry_id` FK eklenir; CHECK yok (sadece live path bağlı).
- M5-B4: `studio_plan_slot_id` FK eklenir; **bu PR'da XOR CHECK** dahil edilir (her iki kaynak da bağlı; manual=NULL/NULL dahil edilebilir).

Bu zamanlama §5 PR sıralamasında yansıtılmıştır.

### 3.2 M5-B1 Scope Lock — `live_plan_entries` foundation (2026-05-06)

K1-K6 kararları kullanıcı tarafından sırayla kilitlendi (2026-05-06). M5-B1 PR'ı bu lock setine göre yazılır.

**K1 — `match_id` / `opta_match_id` (ikisi de nullable):**

```prisma
matchId      Int?    @map("match_id")
optaMatchId  String? @map("opta_match_id") @db.VarChar(80)

match Match? @relation(fields: [matchId], references: [id], onDelete: SetNull)
```

- `matchId`: internal Match FK. Event Match modeliyle eşleşirse iz bırakır.
- `optaMatchId`: external OPTA identity. Aynı OPTA event'ten birden fazla operasyon planı olabileceği için **unique DEĞİL**.
- `metadata.optaMatchId` JSON fallback **yeni tabloda başlatılmaz** — Madde 3 PR-3A transition pattern Schedule içindi; live_plan_entries temiz başlar.

**K2 — `LivePlanStatus` enum (manuel/operasyonel):**

```prisma
enum LivePlanStatus {
  PLANNED      // taslak/ilk kayıt
  READY        // operasyon bilgileri tamam
  IN_PROGRESS  // operasyon/kayıt süreci başladı
  COMPLETED
  CANCELLED
}
```

- `IN_PROGRESS` (RECORDING yerine) seçildi — live-plan sadece kayıt değil, üst operasyon planı.
- Status **manuel update**; ingest_plan_items state'inden DB trigger ile auto-derive **YOK**. UI ileride bağlı ingest item'lardan "derived progress" ayrıca gösterebilir.
- DB-level CHECK constraint'i Prisma enum üzerinden gelir; ek manuel CHECK reapply gerekmez (test setup default).

**K3 — Optimistic locking:**

```prisma
version Int @default(1)
```

- Schedule/Booking ile aynı pattern.
- M5-B2 service implementation: PATCH/PUT'ta `If-Match: <version>` zorunlu; `tx.updateMany({ where: {id, version}, data: { ..., version: { increment: 1 } } })` count=0 → **412 Precondition Failed**.
- M5-B1 sadece kolonu ekler; davranış M5-B2.

**K4 — Audit subject:**

- Yeni `audit_logs.subject = "LivePlanEntry"` (M5-B2 service writes ile aktif olur).
- Eski `schedules.usageScope='live-plan'` audit history `subject="Schedule"` olarak **historical kalır**; M5-B5 cleanup'ta migrate edilmez.
- Subject + aggregateId birleşik kimlik: `Schedule(id=42)` ve `LivePlanEntry(id=42)` farklı satırlar; çakışma yok.

**K5 — API yüzeyi:**

- Canonical `/api/v1/live-plan` (M5-B2'de implementasyon):
  - `GET /api/v1/live-plan` (list)
  - `POST /api/v1/live-plan` (create)
  - `GET /api/v1/live-plan/:id` (detail)
  - `PATCH /api/v1/live-plan/:id` (update; If-Match)
  - `DELETE /api/v1/live-plan/:id` (soft delete; M5-B2'de soft vs hard kararlaştırılır)
- `GET /api/v1/schedules?usageScope=live-plan` shim **YOK**. Eski endpoint cleanup ile gider.
- M5-B6'ya kadar UI eski endpoint'i kullanmaya devam ederse boş/test data görür — sistem inşa aşamasında kabul edilebilir.

**K6 — M5-B1 scope sınırı:**

- Schema foundation only. Davranış değişmez.
- `createdBy` **nullable** (`String? @db.VarChar(100)`) — script/seed/system import için esnek; M5-B2'de route-level kural koyulur (kullanıcı işlemlerinde doldur).

#### M5-B1 Field Set (final)

```prisma
model LivePlanEntry {
  id              Int             @id @default(autoincrement())
  title           String          @db.VarChar(500)
  eventStartTime  DateTime        @map("event_start_time") @db.Timestamptz(6)
  eventEndTime    DateTime        @map("event_end_time")   @db.Timestamptz(6)
  matchId         Int?            @map("match_id")
  optaMatchId     String?         @map("opta_match_id") @db.VarChar(80)
  status          LivePlanStatus  @default(PLANNED)
  operationNotes  String?         @map("operation_notes")
  metadata        Json?
  createdBy       String?         @map("created_by") @db.VarChar(100)
  version         Int             @default(1)
  createdAt       DateTime        @default(now()) @map("created_at")
  updatedAt       DateTime        @updatedAt      @map("updated_at")
  deletedAt       DateTime?       @map("deleted_at")

  match           Match?          @relation(fields: [matchId], references: [id], onDelete: SetNull)

  @@index([status, eventStartTime], map: "live_plan_entries_status_event_start_idx")
  @@index([eventStartTime],         map: "live_plan_entries_event_start_idx")
  @@index([matchId],                map: "live_plan_entries_match_idx")
  @@index([optaMatchId],            map: "live_plan_entries_opta_match_idx")
  @@map("live_plan_entries")
}
```

#### M5-B1 Index Set (final)

| Index | Map | Amaç |
|---|---|---|
| `(status, event_start_time)` | `live_plan_entries_status_event_start_idx` | UI list/filter hot-path (status filtresi + zaman sırası) |
| `(event_start_time)` | `live_plan_entries_event_start_idx` | Date range query (haftalık/günlük view) |
| `(match_id)` | `live_plan_entries_match_idx` | Match relation lookup |
| `(opta_match_id)` | `live_plan_entries_opta_match_idx` | External OPTA dedup/lookup |

`deleted_at` **index DEFERRED** — soft-delete query pattern'i netleşince eklenir (gerekirse M5-B2 veya ayrı PR'da). Audit 3.2.4 gözleminde soft-delete pattern barely-used; index erken eklemek ölçmeden optimize.

#### M5-B1 Out of Scope

- Service / route yazımı (`/api/v1/live-plan` endpoint'leri) → M5-B2.
- UI değişikliği → M5-B6.
- ingest_plan_items FK kolonları → M5-B3 / M5-B4.
- `schedules.usageScope='live-plan'` cleanup → M5-B5.
- Audit subject service-level davranışı → M5-B2 (model hazır, service tarafı yazılırken).
- Outbox shadow yazımı → M5-B2 (live-plan create/update tetiklenirse).
- `deleted_at` index → deferred.

### 3.3 M5-B2 Scope Lock — `/api/v1/live-plan` service/API (2026-05-06)

K7-K14 kararları kullanıcı tarafından sırayla kilitlendi. M5-B2 PR'ı bu lock setine göre yazılır. Implementation öncesi 3 read-only inceleme şart: Schedule routes (If-Match pattern), audit plugin (`apps/api/src/plugins/audit.ts`), `packages/shared/src/types/rbac.ts` permissions map.

**K7 — Route/list shape (minimal V1):**

| Endpoint | Method | Auth | Davranış |
|---|---|---|---|
| `/api/v1/live-plan` | GET | `livePlan.read` | List + filter + pagination |
| `/api/v1/live-plan` | POST | `livePlan.write` | Create (201 + entity DTO) |
| `/api/v1/live-plan/:id` | GET | `livePlan.read` | Detail (404 if not found / soft-deleted) |
| `/api/v1/live-plan/:id` | PATCH | `livePlan.write` | Update (If-Match zorunlu) |
| `/api/v1/live-plan/:id` | DELETE | `livePlan.delete` | Soft delete (If-Match zorunlu) |

List query parametreleri:

| Param | Tip | Default | Davranış |
|---|---|---|---|
| `status` | comma-separated | yok | Multi-value filter (örn. `?status=PLANNED,READY`) |
| `from` | ISO datetime | yok | `event_start_time >= from` |
| `to` | ISO datetime | yok | `event_start_time < to` (half-open interval) |
| `matchId` | int | yok | Exact filter |
| `optaMatchId` | string | yok | Exact filter |
| `page` | int | 1 | ≥1 |
| `pageSize` | int | 50 | ≤200 |

List defaults:
- `WHERE deleted_at IS NULL` (soft-deleted exclude)
- `ORDER BY event_start_time ASC`

**V1 dışı**: `q` text search, custom `sort` parametresi, `includeDeleted=true` admin override. Bunlar V1'e eklenmez (text search index/perf borcu yaratır; sort API yüzeyi gereksiz; includeDeleted RBAC karmaşası getirir).

**K8 — Zod DTO + validation:**

```typescript
const livePlanStatusSchema = z.enum([
  'PLANNED','READY','IN_PROGRESS','COMPLETED','CANCELLED',
]);

const createLivePlanSchema = z.object({
  title:           z.string().trim().min(1).max(500),
  eventStartTime:  z.string().datetime(),
  eventEndTime:    z.string().datetime(),
  matchId:         z.number().int().positive().optional(),
  optaMatchId:     z.string().trim().min(1).max(80).optional(),
  status:          livePlanStatusSchema.optional().default('PLANNED'),
  operationNotes:  z.string().trim().max(8_000).optional(),
  metadata:        z.record(z.unknown()).optional(),  // object only; array değil
}).refine(
  (d) => new Date(d.eventEndTime) > new Date(d.eventStartTime),
  { message: 'eventEndTime eventStartTime\'tan sonra olmalı', path: ['eventEndTime'] },
);

const updateLivePlanSchema = createLivePlanSchema.partial()
  // İki tarih birlikte gelirse Zod refine eder.
  // Sadece biri gelirse service-level merge-aware check (BookingService pattern).
  .refine((d) => Object.keys(d).length > 0, {
    message: 'En az bir field güncellenmeli',
  });

const listLivePlanQuerySchema = z.object({
  status:      z.string().optional()
                .transform((s) => s ? s.split(',').filter(Boolean) : undefined)
                .pipe(z.array(livePlanStatusSchema).optional()),
  from:        z.string().datetime().optional(),
  to:          z.string().datetime().optional(),
  matchId:     z.coerce.number().int().positive().optional(),
  optaMatchId: z.string().trim().min(1).optional(),
  page:        z.coerce.number().int().positive().default(1),
  pageSize:    z.coerce.number().int().positive().max(200).default(50),
});
```

**Service-level merge-aware date check (update path):**
- Sadece `eventEndTime` gelirse: existing `eventStartTime` ile karşılaştır → > değilse 400.
- Sadece `eventStartTime` gelirse: existing `eventEndTime` ile karşılaştır → < değilse 400.
- BookingService `update()` pattern'iyle aynı.

**Metadata kuralı**: object only (`Record<string, unknown>`). Prisma JSON kolonu teorik olarak array/string/null kabul eder ama metadata semantik olarak object. Helper veya Zod schema doğrudan `z.record(...)` ile object zorlanır.

**K9 — If-Match / optimistic locking (PATCH + DELETE) — Schedule'dan bilinçli ayrışma:**

Pre-impl investigation (2026-05-06) sonucu: Schedule pattern If-Match'i **opsiyonel** yapmış. `schedule.routes.ts:298-310` + `schedule.service.ts:365-375` analizi:
- Header missing/invalid → `version=undefined`; service `where` clause'unda version check **skip** edilir.
- `result.count !== 1 ? (ifMatchVersion ? 412 : 404)` → version yoksa sadece "row not found" semantiği.
- DELETE handler'ı (`schedule.routes.ts:317`) optimistic lock **hiç kullanmıyor** (`svc.remove(id)` doğrudan).

Bu davranış optimistic locking'in amacını fiilen zayıflatıyor (lost update riski). Live-plan **yeni API yüzeyi** olduğu için bu zayıflığı taşımayacak — K3 optimistic locking lock'una gerçekten uymak için If-Match zorunlu yapılır.

**Karar (kullanıcı 2026-05-06): Schedule pattern KULLANILMAZ**; live-plan If-Match zorunluluğunu uygular.

| Durum | HTTP |
|---|---|
| Header `If-Match` eksik | **428 Precondition Required** |
| `If-Match` integer parse edilmez (örn. `'abc'`) | **400 Bad Request** |
| Row not found | 404 |
| Row exists ama `deleted_at != NULL` | **404** (soft-deleted gizli) |
| Row exists, version mismatch | **412 Precondition Failed** |
| PATCH happy | 200 + updated entity DTO |
| DELETE happy | 200 + soft-deleted entity DTO |

**PATCH ve DELETE ikisinde de** If-Match zorunlu. DELETE soft delete olduğu için yine bir write operasyon; iki kullanıcıdan biri silerken diğeri update ediyorsa version koruması gerekir.

**Implementation iki adım:**
1. `findUnique({ where: { id } })` — yoksa veya `deletedAt != null` → 404.
2. `tx.livePlanEntry.updateMany({ where: { id, version, deletedAt: null }, data: { ...merged, version: { increment: 1 } } })` — count=0 → 412.

**Doc note (M5-B2 PR'ında commit message + service yorum):**
> Schedule investigation showed If-Match is optional there. Live-plan intentionally requires it because this is a new API surface and K3 optimistic locking must be enforced.

**K10 — Audit subject implementation (otomatik):**

Pre-impl investigation (2026-05-06) sonucu: `apps/api/src/plugins/audit.ts:107-136` analizi — Prisma `$extends` audit plugin model adından `entityType` alanını **otomatik** doldurur. `entityId` Prisma `result.id` veya `before.id`'den otomatik. Action type Prisma operation'dan türetilir.

**Sonuç:** K4 lock'u (`subject = "LivePlanEntry"`) **ek kod gerektirmez**. `LivePlanEntry` Prisma model adı doğrudan audit log'a `entityType="LivePlanEntry"` olarak yazılır. M5-B2 service'inde audit context override **yapılmaz**.

Historical Schedule audit migrate edilmez (K4 lock).

**Soft delete audit coverage — integration test ile doğrulama (2026-05-06 ek not):**

Soft delete `prisma.livePlanEntry.update({...})` veya `updateMany` çağrısıyla yapılır. Audit plugin `update` ve `updateMany` operasyonlarını kapsar (audit.ts:88-101 before-snapshot logic). Yine de:

- M5-B2 integration test'inde **soft delete audit coverage doğrulaması** eklenir: DELETE endpoint'i çağrılır → `audit_logs`'ta `entityType='LivePlanEntry'`, `action='delete'` veya `'update'` (plugin convention'ına göre) entry oluşmuş olmalı.
- Eğer audit plugin soft-delete-via-update'i `delete` action olarak tanımıyorsa (gerçek `prisma.delete()` değil, sadece `update({deletedAt})` olduğundan) **service-level audit pattern** revize edilir (örn. action-level override veya delete operasyonunu farklı yöntemle).
- Bu test M5-B2 PR'ı içinde implement edilir; keşif sonucu pattern revizesi gerekirse o PR'ın scope'una alınır.

**K11 — Soft delete only:**

| Davranış | Detay |
|---|---|
| DELETE endpoint | Soft (`deletedAt = NOW()`, `version++`) |
| If-Match header | Zorunlu |
| Hard delete | V1'de YOK |
| Force delete (`?force=true`) | V1'de YOK |
| Soft-deleted row detail/list | Görünmez (404 / exclude) |
| Soft-deleted row PATCH/DELETE | 404 |
| `includeDeleted=true` admin override | V1'de YOK |

PK auto-increment olduğu için soft-deleted ID asla yeniden kullanılmaz; audit subject + aggregateId çakışması olmaz.

**K12 — Outbox shadow events:**

Live-plan create/update/delete service akışlarında outbox shadow yazılır (Phase 2 invariant: `status='published'`, poller pick etmez).

| Event type | aggregateType | Trigger | Payload (minimal) |
|---|---|---|---|
| `live_plan.created` | `LivePlanEntry` | POST sonrası | `{ livePlanEntryId: id }` |
| `live_plan.updated` | `LivePlanEntry` | PATCH sonrası | `{ livePlanEntryId: id }` |
| `live_plan.deleted` | `LivePlanEntry` | DELETE sonrası | `{ livePlanEntryId: id }` |

**M5-B2 dışı**: queue routing + consumer. `apps/api/src/modules/outbox/outbox.routing.ts:EVENT_TYPE_TO_QUEUE` map'ine **eklenmez**. Phase 2'de poller pick etmediği için routing eksik olması sorun değil.

**Risk**: PR-C2 cut-over M5-B2'den **önce** deploy edilirse, M5-B2 sonrası yeni live-plan event'leri `pending` yazmaya başlar; routing eksik olduğu için poller `failed` state'ine düşer. Mitigasyon: M5-B2 implementation öncesi production outbox mode kontrol edilir; PR-C2 deploy edilmişse routing entry önce eklenir.

Idempotency key kullanılmaz (cross-producer dedup gerek yok; tek üretici live-plan service).

**K13 — RBAC permissions namespace (Schedule clone, locked 2026-05-06):**

Pre-impl investigation (2026-05-06) sonucu: `packages/shared/src/types/rbac.ts` analizi — domain → action map pattern doğrulandı; `[]` empty = "all authenticated" konvansiyonu (service-level filter); SystemEng demoted (2026-05-01 RBAC restructure).

**Karar (kullanıcı 2026-05-06): Schedule.write/delete clone pattern.**

```ts
livePlan: {
  read:   [] as BcmsGroup[],                                                 // all authenticated
  write:  ['Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],
  delete: ['Tekyon', 'Transmisyon', 'Booking', 'YayınPlanlama'] as BcmsGroup[],
}
```

**Hardcoded group YOK** — route handler'lar `app.requireGroup(...PERMISSIONS.livePlan.X)` pattern. `Admin` auto-bypass `isAdminPrincipal()` davranışı korunur (Admin listede yok ama her endpoint'e erişir).

**Doc note (rbac.ts yorum + commit message):**
> Live-plan bugün yayın operasyonuna yakın çalıştığı ve Schedule ile aynı kullanıcı kitlesi tarafından yönetileceği için V1'de Schedule.write grubu clone edilir. Yetki daraltma RBAC audit sonrası ayrı karar olabilir.

Reddedilen alternatifler:
- Daha dar (`['Booking', 'YayınPlanlama']` only): Tekyon/Transmisyon Schedule.write'da var; live-plan'a erişimsiz bırakmak production iş akışını kırabilir; gerekirse RBAC audit sonrası daraltılır.
- Schedule.write'ın aynı seti (4 grup) kullanılır; Ingest dahil edilmez (Ingest read için all-auth empty array zaten yeterli).

**K14 — Response shape:**

Schedule list/detail/create/update/delete response shape authoritative. Implementation öncesi `schedule.routes.ts` + `schedule.service.ts` response builder okunur.

Fallback target shape (Schedule pattern eksikse):

```typescript
// List
interface ListLivePlanResponse {
  items:    LivePlanEntryDto[];
  total:    number;
  page:     number;
  pageSize: number;
}

// Detail / Create / Update / Delete
type LivePlanEntryDto = {
  id:              number;
  title:           string;
  eventStartTime:  string;       // ISO 8601
  eventEndTime:    string;
  matchId:         number | null;
  optaMatchId:     string | null;
  status:          'PLANNED'|'READY'|'IN_PROGRESS'|'COMPLETED'|'CANCELLED';
  operationNotes:  string | null;
  metadata:        Record<string, unknown> | null;
  createdBy:       string | null;
  version:         number;
  createdAt:       string;
  updatedAt:       string;
  deletedAt:       string | null;  // detail'de hiç görünmez ama type'da var
};
```

HTTP status:
- POST → 201 + entity DTO
- PATCH → 200 + entity DTO
- DELETE → 200 + soft-deleted entity DTO (Schedule pattern; eğer Schedule 204 dönüyorsa o pattern uygulanır)
- GET list → 200 + ListLivePlanResponse
- GET detail → 200 + entity DTO

Field naming: Prisma camelCase (DTO) ↔ DB snake_case (kolon). Service mapping otomatik (Prisma client zaten camelCase döndürür).

#### M5-B2 Out of Scope

- Frontend / UI değişikliği → M5-B6.
- Outbox routing/consumer → M5-B2 dışı (K12).
- ingest_plan_items live_plan_entry_id FK → M5-B3.
- studio_plan_slot_id FK + XOR CHECK → M5-B4.
- Eski `schedules.usageScope='live-plan'` cleanup → M5-B5.
- `q` text search, custom sort, `includeDeleted` → V1 dışı (K7).
- Hard delete / force delete → V1 dışı (K11).

#### M5-B2 Pre-impl Read-Only Investigation (✅ COMPLETED 2026-05-06)

3 dosya read-only inceleme yapıldı, bulgular K9/K10/K13'e yansıtıldı:

1. **`apps/api/src/modules/schedules/schedule.service.ts:update()` + `schedule.routes.ts:298-310`** — If-Match Schedule'da **opsiyonel** (missing/invalid silently skip). DELETE handler optimistic lock kullanmıyor. **Sonuç**: K9 Schedule pattern'den **bilinçli ayrışıyor** — live-plan If-Match zorunlu.
2. **`apps/api/src/plugins/audit.ts:107-136`** — Prisma `$extends` audit plugin model adından `entityType` **otomatik** doldurur. **Sonuç**: K10 (a) otomatik; ek mapping yok. Soft delete audit coverage M5-B2 integration test'inde doğrulanır.
3. **`packages/shared/src/types/rbac.ts:57-135`** — Domain → action map pattern; `[]` empty = "all authenticated"; SystemEng demoted; Schedule.write = `['Tekyon','Transmisyon','Booking','YayınPlanlama']`. **Sonuç**: K13 Schedule.write/delete clone pattern.

Bulguların hiçbirinde scope blocker yok; M5-B2 implementation başlayabilir.

---

## §4 — Open & Deferred Decisions

### 4.1 Booking ↔ Schedule cleanup (✅ CLOSED 2026-05-06)

**Soru**: Mevcut 129 test live-plan schedule satırına bağlı bookings var mı? Varsa M5-B5 cleanup'ta nasıl ele alınacak?

**Pre-req sonucu**: §6.3 SQL local dev DB üzerinde çalıştırıldı — **0 satır** (live-plan schedule satırlarına bağlı booking yok).

**Karar (V1)**:
- Booking'e `live_plan_entry_id` FK **eklenmez**.
- Booking broadcast-bound varsayımı korunur.
- M5-B5 cleanup CASCADE riski göstermiyor; güvenli.
- Live-plan'a bağlı booking ihtiyacı V2 scope'a bırakılır.

**Caveat**: Local dev DB inventory production-like dataset kabul edilerek karar verildi (sistem inşa aşamasında, kullanıcı teyidi 2026-05-06). Production deploy öncesi gerçek production DB'de (varsa) aynı sorgu tekrar çalıştırılarak 0 satır invariant'i doğrulanır.

### 4.2 sourceType / sourceKey cleanup timing (DEFERRED)

`ingest_plan_items.sourceType` ve `sourceKey` kolonları FK'lar eklenince **transitional kalır**:
- Yeni logic dual FK üzerinden çalışır.
- Eski sourceType + sourceKey okuma yapan kod (UI, import/export, raporlar) bir süre devam edebilir.
- Removal **M5-B6 sonrası** ayrı cleanup PR'da değerlendirilir.

**Doc kuralı (transitional invariant)**:
> `sourceType` / `sourceKey` are transitional compatibility fields after FK introduction.
> No new logic should depend on them once FK paths are live.
> Removal deferred to M5 cleanup PR after UI/API migration.

Bu invariant M5-B3+B4 sonrası kod review checklist'inde kontrol edilir (kod dependency added/removed denetlenir).

---

## §5 — Strangler PR Sequencing

### M5-A — Decision doc + audit severity correction

**Status**: Bu PR (henüz commit edilmedi; commit kullanıcı onayı bekliyor).

İçerik:
- Bu doc (`ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md`).
- Audit doc 3.2.2 severity revize ([ÖNEMLİ] → [BİLGİ]) + finding düzeltmesi (channel_id NULL bug değil, iki domain conflation).
- schedule.content_id orphan finding (yeni; ayrı triage notu).
- Kod değişikliği yok.

### M5-B1 — `live_plan_entries` foundation (yeni boş tablo)

**Scope lock**: §3.2 (K1-K6 + field/index set + out-of-scope).

İçerik:
- Migration: `live_plan_entries` tablosu + `LivePlanStatus` enum (§3.2 K2).
- Prisma model `LivePlanEntry` (§3.2 field set).
- 4 index (§3.2 index set; `deleted_at` index deferred).
- Test interim helper (gerekiyorsa CHECK reapply — Madde 4 / PR-A pattern).
- Tablo henüz **kullanılmaz** (kimse okuyup yazmıyor); davranış değişmez.

Foundation pattern: Madde 2+7 PR-A'daki gibi — boş tablo + Prisma + test, davranış değişmez.

### M5-B2 — Live-plan service/API yeni tabloya yazar

**Scope lock**: §3.3 (K7-K14 + route/DTO/If-Match/audit/soft delete/outbox shadow/RBAC/response).

İçerik:
- Yeni `live-plan.service.ts` + `live-plan.routes.ts` (modules/live-plan/).
- Canonical 5 endpoint (§3.3 K7).
- Zod DTO + service-level merge-aware date check (§3.3 K8).
- If-Match optimistic lock PATCH/DELETE (§3.3 K9).
- Audit subject "LivePlanEntry" (§3.3 K10).
- Soft delete only (§3.3 K11).
- Outbox shadow events (live_plan.created/updated/deleted; routing M5-B2 dışı — §3.3 K12).
- PERMISSIONS.livePlan.read/write/delete (§3.3 K13).
- Response shape Schedule pattern (§3.3 K14).

**M5-B2 dışı:** UI değişikliği, outbox routing/consumer, ingest FK, eski schedules cleanup, schedules read fallback (test data §4.1 closed; doğrudan M5-B5 cleanup).

**Pre-impl read-only:** §3.3 sonu — Schedule routes (If-Match), audit.ts (subject pattern), rbac.ts (PERMISSIONS pattern).

### M5-B3 — `ingest_plan_items.live_plan_entry_id` FK

İçerik:
- Migration: `live_plan_entry_id INT NULL FK → live_plan_entries.id (ON DELETE RESTRICT)`.
- Yeni ingest plan item'lar `sourceType='live-plan'` olduğunda `live_plan_entry_id` doldurulur.
- Eski sourceType + sourceKey paralel kalır (transitional).
- **XOR CHECK YOK henüz** — sadece live path bağlı.

### M5-B4 — `ingest_plan_items.studio_plan_slot_id` FK + XOR CHECK

İçerik:
- Pre-req inventory: §6.2 SQL `sourceType='studio-plan'` satır sayısı; varsa data analiz / cleanup.
- Migration: `studio_plan_slot_id INT NULL FK → studio_plan_slots.id (ON DELETE RESTRICT)`.
- XOR CHECK constraint:
  ```sql
  ALTER TABLE ingest_plan_items
    ADD CONSTRAINT ingest_plan_items_source_xor CHECK (
      (live_plan_entry_id IS NOT NULL AND studio_plan_slot_id IS NULL) OR
      (live_plan_entry_id IS NULL AND studio_plan_slot_id IS NOT NULL) OR
      (live_plan_entry_id IS NULL AND studio_plan_slot_id IS NULL)
    );
  ```
- Test interim helper (Madde 4 pattern) reapply.

### M5-B5 — Cleanup test data

İçerik:
- §6.3 booking inventory (open decision §4.1 kapanır):
  - Bookings yoksa veya test ise: CASCADE delete ile birlikte silinir.
  - Production bookings varsa: M5 durur.
- `DELETE FROM schedules WHERE usage_scope='live-plan'` (test data temizliği).
- M5-B2'deki read fallback (UNION) kaldırılır.
- 132 satırın 129'u düşer; schedules **3 broadcast satır + bundan sonra yazılan yeni broadcast satırları** olur.

### M5-B6 — UI separation

İçerik:
- Frontend route: `/schedules` (broadcast list — daraltılmış kapsam) + `/live-plan` (live-plan list — yeni component).
- Schedule-list 2385 satır component (**Madde 6**) bu PR'a girmez — Madde 6 ayrı PR'da işlenir.
  - Sebep: domain ayrımı (yeni `live-plan-list-component`) + 2385 satır refactor aynı PR'a girerse review/test sürtünmesi yüksek.
  - Önceki taslakta "B2 ile birleştir" önerimi geri çekildi (kullanıcı önerisi sonrası).
- Live-plan ekranında "bağlı ingest_plan_items + portları" gösterimi (read-only via FK relation).

### M5-B7 (opsiyonel; deferred) — `sourceType` cleanup

İçerik (§4.2 deferred decision):
- UI/API'de sourceType string kullanımı kalkmış mı kontrol et.
- Kalkmışsa: `sourceType` + `sourceKey` kolonları DROP migration.
- Kalkmamışsa: PR-D7 vb. ileri tarihe ertele.

### Madde 6 ile İlişki (revize)

Önceki taslakta "Madde 6 ↔ M5-B6 birlikte" önerilmişti; **kullanıcı kararı (2026-05-06) ayrı tutmak**:

- **Önce backend** schema/service boundary (M5-B1...B5).
- **Sonra UI route/list ayrımı** (M5-B6).
- **En son** Madde 6 schedule-list 2385 satır component refactor (ayrı PR).

Sebep: M5-B6 zaten yeni `live-plan-list-component` ekliyor + mevcut `schedule-list-component`'ten live-plan kısmı çıkıyor; component **doğal olarak** küçülüyor. Madde 6'nın geriye kalan refactor scope'u bu sayede daha küçük olur.

---

## §6 — Pre-req SQL Queries + Inventory Results

Read-only doğrulamalar. **Local dev DB üzerinde 2026-05-06'da çalıştırıldı** (sistem inşa aşamasında olduğundan production-like dataset kabul edildi, kullanıcı onayı). Production deploy öncesi gerçek production DB varsa aynı sorgular tekrar çalıştırılır (production network onayı ayrı).

### 6.1 schedules usage_scope/channel_id breakdown

```sql
SELECT
  usage_scope,
  (channel_id IS NULL) AS no_channel,
  COUNT(*) AS toplam
FROM schedules
GROUP BY usage_scope, channel_id IS NULL
ORDER BY toplam DESC;
```

Beklenen örnek dağılım:
- `live-plan` + no_channel=true → ~129 (test data)
- `broadcast` + no_channel=false → ~3 (test broadcast)

Ne arıyoruz: **anomalous kombinasyonlar**:
- `broadcast` + no_channel=true → schedule yayın akışında ama channel atanmamış (workflow state, normal — sayım önemli)
- `live-plan` + no_channel=false → live-plan satırına channel atanmış (anomali, doğrula)

### 6.2 ingest_plan_items sourceType breakdown

```sql
SELECT
  source_type,
  COUNT(*) AS toplam
FROM ingest_plan_items
GROUP BY source_type
ORDER BY toplam DESC;
```

Ne arıyoruz: M5-B4 öncesi `sourceType='studio-plan'` satır sayısı (FK eklenmeden önce data inventory) + diğer beklenmedik discriminator değerleri.

### 6.3 Bookings tied to live-plan schedules

```sql
SELECT
  b.id,
  b.task_title,
  b.status,
  b.created_at,
  s.id AS schedule_id,
  s.usage_scope,
  s.title AS schedule_title
FROM bookings b
LEFT JOIN schedules s ON s.id = b.schedule_id
WHERE s.usage_scope = 'live-plan' AND s.deleted_at IS NULL
ORDER BY b.created_at DESC;
```

Ne arıyoruz: live-plan schedule satırlarına bağlı booking var mı? §4.1 open decision'ı bu sorgu kapatır:
- 0 satır veya hepsi test → cleanup OK.
- Production bookings → M5 durur, Booking semantic kararı.

### 6.4 Local dev DB inventory result (2026-05-06)

Üç sorgu local docker `bcms_postgres` container'ında çalıştırıldı (kullanıcı onayı; sistem inşa aşamasında, dataset test).

#### 6.4.1 schedules breakdown

```
 usage_scope | no_channel | toplam
-------------+------------+--------
 live-plan   | t          |    129
 live-plan   | f          |      3
```

**Bulgular:**
- 129 satır: live-plan + no_channel=true (beklenen).
- 3 satır: live-plan + no_channel=false (channel atanmış live-plan; düşük-severity anomali).
- **0 satır: usage_scope='broadcast'** — current dev DB'de tüm schedules satırları live-plan; broadcast hiç kullanılmamış.

**Yorum:**
- Schedules tablosu canonical broadcast slot olarak **boş başlayabilir**. Bu durum migration shim ihtiyacını azaltır (mevcut broadcast satırlarını taşımaya gerek yok; zaten yok).
- 3 channel-atanmış live-plan satırı: M5-B5 cleanup ile diğer 129 ile birlikte silinir. Test data; B1/B2 sonrası yeni live-plan schedules'a yazmayacağı için tekrar oluşmaz. **Erken CHECK rule önerilmiyor** — workflow'u daraltmamak için.

#### 6.4.2 ingest_plan_items source_type breakdown

```
 source_type | toplam
-------------+--------
 live-plan   |     49
 studio-plan |     14
 ingest-plan |      2
 manual      |      1
```

**Bulgular:**
- 49 live-plan kaynaklı → M5-B3 FK migration'ında bağlanacak.
- 14 studio-plan kaynaklı → M5-B4 FK migration'ında studio_plan_slots.id'ye map edilebilirlik kontrolü gerek (sourceKey formatı incelenir).
- 2 ingest-plan + 1 manual → legacy/transitional discriminator; FK'siz branch (XOR CHECK NULL/NULL düşer; manual gibi davranır).

**Yorum:**
- M5-B4 öncesi 14 studio-plan satırının sourceKey değerlerinin studio_plan_slots tablosundaki record'lara map edilebildiği doğrulanmalı (bu da bir ek inventory; B4 PR'ı içinde yapılır).
- `'ingest-plan'` ve `'manual'` discriminator'ları FK gerektirmez; mevcut ingest.routes.ts:598 davranışı (manuel silinebilir kategorisi) korunur.

#### 6.4.3 bookings tied to live-plan schedules

```
 booking_id | task_title | status | created_at | schedule_id | usage_scope | schedule_title
------------+------------+--------+------------+-------------+-------------+----------------
(0 rows)
```

**Bulgular:** 0 satır.

**Yorum:**
- §4.1 open decision V1 için **closed**.
- M5-B5 cleanup booking CASCADE riski göstermiyor.
- Booking broadcast-bound varsayımı V1'de korunur.

---

## §7 — Audit Cross-Reference

### 7.1 Finding 3.2.2 severity revize

> **[ORIGINAL]** [ÖNEMLİ] 3.2.2 — 129/132 schedule channel_id IS NULL — neredeyse tüm live-plan record'ları GiST exclusion bypass; çakışma kontrolü application layer'a düşmüş ama service kodunda live-plan için explicit overlap check yok.

Düzeltme (kullanıcı kararı 2026-05-06):

> **[REVIZE]** [BİLGİ] 3.2.2 — `schedules` tablosu iki ayrı domain entity'i (yayın akışı + operasyon üst planı) tek tabloda taşıyor. `channel_id IS NULL` workflow state, bug değil; live-plan'ın çakışma kontrolü zaten port-bazlı (`ingest_plan_item_ports` GIST). Asıl mimari iş: live-plan'ı kendi tablosuna taşımak (Madde 5 kararı; bkz `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md`).

Audit doc'ta (`BCMS_INDEPENDENT_AUDIT_2026-05-04.md`) 3.2.2 satırı bu revizeyi yansıtacak şekilde güncellenir; M5-A commit'inin parçası.

### 7.2 Finding 3.1.4 referans

Mevcut: `usageScope` CHECK constraint var, integration test mevcut. M5'te `usageScope` kolonu **kalır** (locked decision §3.9); bu finding kapalı kalır.

### 7.3 Yeni finding — schedule.content_id orphan

**Yeni audit girdisi** (M5-A commit'inde audit doc'a eklenir):

> [DÜŞÜK] 3.1.X — `schedules.content_id Int?` orphan kolon. Schema'da `Content` veya `Asset` modeli yok; FK değil; iş mantığı yok (Zod validation + DB write-through dışında). Yarım kalmış bir tasarım veya external system reference olabilir. Triage: kolon DROP / rename / canonical asset entity yarat — Madde 5 dışında ayrı karar.

Bu finding M5 scope'una **dahil edilmiyor** (locked decision §3.14). Asset entity tasarımı ileri bir audit triage / V2 scope.

### 7.4 Madde 5 audit satırı güncelleme

`BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 5 (skip listesi) satırı revize edilir:

> **[ESKİ]** Schedule `channel_id NULL` live-plan (mimari karar — ayrı tablo mı?)
>
> **[YENİ]** Live-plan ayrı entity migration — strangler M5-B1...B6 (decision doc `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md`); channel_id NULL workflow state olarak kabul edildi (3.2.2 severity revize).

---

## §8 — Sonraki Adımlar

1. ✅ **M5-A decision doc commit** (`729c74c`).
2. ✅ **Audit state sync commit** (`3b70957`) — 3.2.2 severity revize, Madde 5 skip listesi satırı, yeni 3.1.21 content_id orphan finding.
3. ✅ **§6 SQL inventory** (local dev DB, 2026-05-06) — sonuçlar §6.4'te; §4.1 closed.
4. **M5-B1 schema PR** — open decision yok; başlanabilir. İçerik: `live_plan_entries` foundation tablosu + Prisma model + migration + test interim helper.
5. **Production deploy öncesi**: gerçek production DB varsa §6 SQL'leri tekrar çalıştırılarak invariant'ler doğrulanır (network onayı ayrı; kullanıcı `obskan` feedback memory).
6. **M5-B4 öncesi**: 14 studio-plan satırının sourceKey → studio_plan_slots.id map edilebilirliği inceleme (ek inventory; B4 PR'ı içinde).

---

**Maintainer**: kullanıcı (osmanbaskan / obskan)
**Implementer**: Claude (M5-B1 talep edildiğinde + open decision §4.1 kapandıktan sonra)
