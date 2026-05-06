# Live-Plan Data Model — Karar Notu

> **Status**: 🟢 14 karar locked (2026-05-06); 1 open + 1 deferred; M5-A (bu doc) implement edildi sayılır. Schema PR'ları (M5-B1+) açık kararlar netleştikten sonra başlar.
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
| ✅ Locked | 14 | §3 |
| ⚠️ Open | 1 | §4.1 — Booking semantic (production data analizine bağlı) |
| ⏸️ Deferred | 1 | §4.2 — `sourceType`/`sourceKey` cleanup timing |
| 🔍 Pre-req SQL | 3 | §6 — production read-only doğrulamaları |

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

---

## §4 — Open & Deferred Decisions

### 4.1 Booking ↔ Schedule cleanup (OPEN)

**Soru**: Mevcut 129 test live-plan schedule satırına bağlı bookings var mı? Varsa M5-B5 cleanup'ta nasıl ele alınacak?

**Pre-req**: §6.3 SQL — production read-only inventory.

**Karar matrisi**:
- **Eğer hiç booking yoksa veya bookings test data'sı ise**: birlikte silinir (CASCADE), ek karar yok.
- **Eğer production booking varsa**: M5 durur; Booking semantic kararı gerekir (broadcast-only mu, live-plan'a da bağlanmalı mı?).

**V1 default**: Booking'e `live_plan_entry_id` FK **eklenmez**. Booking broadcast-bound varsayımı korunur. Live-plan'a bağlı bookings mevcut değilse / test ise cleanup; mevcutsa M5 scope dışı bir karar.

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

İçerik:
- Migration: `live_plan_entries` tablosu oluştur (event/operasyon fields + status enum + audit fields + version optimistic locking).
- Prisma model `LivePlanEntry`.
- Status enum yeni Prisma type: `LivePlanStatus` (PLANNED/READY/RECORDING/COMPLETED/CANCELLED gibi — schema'da netleşir).
- Test interim helper (Madde 4 / PR-A pattern; gerekiyorsa CHECK constraint reapply).
- Tablo henüz **kullanılmaz** (kimse okuyup yazmıyor); sadece schema foundation.

Foundation pattern: Madde 2+7 PR-A'daki gibi — boş tablo + Prisma + test, davranış değişmez.

### M5-B2 — Live-plan service/API yeni tabloya yazar

İçerik:
- Yeni `live-plan.service.ts` veya `live-plan.routes.ts` (mevcut akışın incelemeye göre konumlanır).
- Live-plan create/update artık **`live_plan_entries`'e yazar**, `schedules`'a yazmaz.
- Read fallback: **opsiyonel** — eski `schedules.usageScope='live-plan'` satırları test data ise fallback hiç eklenmez ve M5-B5'te direkt cleanup yapılır. Production data tespit edilirse (§4.1 open decision sonrası) UNION read fallback eklenebilir.
- Default tercih: fallback eklenmesin; B2 sadece yeni tabloya yazımı bağlar.

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

## §6 — Pre-req SQL Queries

Production read-only doğrulamalar. M5-B5 ve M5-B4 öncesi çalıştırılması zorunlu. **Ayrı onay gerektirir** (kullanıcı `obskan` "network onayı zorunlu" feedback memory).

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

1. **Doc commit + push** (kullanıcı onayı bekliyor).
2. Audit doc satırları güncelle (3.2.2 severity, Madde 5 skip listesi satırı, yeni 3.1.X content_id orphan) — bu commit veya ayrı `docs(audit): state sync` commit'i.
3. **§6 SQL pre-req'leri production'da çalıştırma onayı** — kullanıcı `obskan` ayrıca onaylar (network onayı zorunlu memory):
   - 6.1 → 4.1 open decision'ı kısmen aydınlatır (anomalous kombinasyon).
   - 6.2 → M5-B4 öncesi gereklidir (studio_plan satırı kaç tane).
   - 6.3 → 4.1 open decision'ı kapatır (Booking cleanup yolu netleşir).
4. SQL sonuçları gelince §4 open/deferred ya kapanır ya da M5-A doc'a güncelleme commit'i atılır.
5. **M5-B1 schema PR** — açık kararlar netleştikten sonra.

---

**Maintainer**: kullanıcı (osmanbaskan / obskan)
**Implementer**: Claude (M5-B1 talep edildiğinde + open decision §4.1 kapandıktan sonra)
