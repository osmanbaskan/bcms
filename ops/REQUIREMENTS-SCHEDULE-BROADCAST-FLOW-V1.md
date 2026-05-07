# Schedule / Yayın Planlama — Broadcast Flow Requirements V1

> **Status**: Locked draft (K1-K32, 2026-05-07). Implementation öncesi inventory gerekir.
> **Decision cross-reference**: `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §3.5 K16.
> **Scope**: Schedule/Yayın Planlama domain split, event identity, channel propagation, JSON cleanup hedefi.

---

## §0 — Domain Ownership

Bu doc'un temel kuralı:

- **Canlı Yayın Plan**: OPTA + manuel canlı yayın event verileri `live_plan_*` DB domain'inde yaşar.
- **Schedule / Yayın Planlama**: Seçilmiş event'in hangi kanal(lar)da ve hangi yayın saatinde akışa girdiğini tutar.
- **Stüdyo Planı**: Manuel stüdyo plan verileri kendi DB domain'inde yaşar.
- **Ingest**: Canlı Yayın Planı ve Stüdyo Planı'ndan gelen **isim + saat** bilgisini ingest için ayrılmış DB kayıtlarında takip eder.

Ingest ana event kaynağı değildir. Canlı Yayın Plan event'i ile ingest plan item aynı şey değildir. Schedule/Yayın Planlama'dan Ingest'e veri akışı yoktur.

---

## §1 — UI Hedefi

Sol menü hedefi:

| Menü | Route | Domain |
|---|---|---|
| Canlı Yayın Plan | `/live-plan` | `live_plan_*` structured DB ekranı |
| Yayın Planlama | `/schedules` | Schedule/broadcast flow ekranı |
| Stüdyo Planı | `/studio-plan` | Studio domain |
| Ingest | `/ingest` | Ingest execution domain |
| Lookup Yönetimi | `/admin/live-plan-lookups` | Lookup yönetimi |

Silinecek kullanıcı etiketi:

- **"Live-Plan (yeni)"**

Schedule/Yayın Planlama ekranında gösterilecek kolonlar:

| UI Label | Kaynak / DB |
|---|---|
| TARİH | `schedules.schedule_date` |
| TAKIM 1 | `schedules.team_1_name` (seçilen live-plan entry'den kopya) |
| TAKIM 2 | `schedules.team_2_name` (seçilen live-plan entry'den kopya) |
| SAAT | `schedules.schedule_time` |
| KANAL 1 | `schedules.channel_1_id` |
| KANAL 2 | `schedules.channel_2_id` |
| KANAL 3 | `schedules.channel_3_id` |
| TİCARİ | `commercial_option_id` lookup |
| LOGOLAR | `logo_option_id` lookup |
| FORMAT | `format_option_id` lookup |

Required:

- Seçilen içerik / `event_key`
- `schedule_date`
- `schedule_time`

Opsiyonel:

- `channel_1_id`, `channel_2_id`, `channel_3_id`
- `commercial_option_id`
- `logo_option_id`
- `format_option_id`

Schedule ekranı teknik detay, transmisyon segmentleri veya ingest port planı tutmaz.

---

## §2 — Event Identity

Schedule ve Live-Plan ortak `event_key` kullanır.

Formatlar:

| Source | Format |
|---|---|
| OPTA | `opta:<optaMatchId>` |
| Lokal match (rezerve) | `match:<matchId>` |
| Manuel | `manual:<generatedUuid>` |

DB kuralları:

- `schedules.event_key` UNIQUE.
- `live_plan_entries.event_key` non-unique.
- `ingest_plan_items` tarafında aynı event için birden fazla kayıt olabilir.

Anlam:

- Schedule/Yayın Planlama tarafında aynı event için tek satır vardır.
- Live-plan tarafında aynı event için birden fazla operasyon kaydı olabilir.

---

## §3 — Live-Plan Source Type + Content Selection

`live_plan_entries.source_type` alanı eklenir:

```text
OPTA | MANUAL
```

Kayıt kuralları:

- OPTA kayıt:
  - `source_type='OPTA'`
  - `opta_match_id` dolu
  - `event_key='opta:' || opta_match_id`
- Manuel kayıt:
  - `source_type='MANUAL'`
  - `opta_match_id` NULL
  - `event_key='manual:' || generated_uuid`

Schedule içerik seçimi `live_plan_entries` üzerinden yapılır:

- **OPTA'dan Seç** → `live_plan_entries WHERE source_type='OPTA'`
- **Manuel İçerik** → `live_plan_entries WHERE source_type='MANUAL'`

Manuel live-plan entry iki yerden oluşturulabilir:

- Canlı Yayın Plan sekmesi.
- Schedule/Yayın Planlama ekranındaki "Manuel İçerik Ekle" akışı.

Her iki durumda da kayıt `live_plan_entries` tablosuna yazılır. Schedule kendi manuel içerik tablosu oluşturmaz.

Takım isimleri Schedule ekranında yazılmaz; seçilen entry'den `team_1_name` / `team_2_name` olarak kopyalanır.

---

## §4 — Schedule Data Model

Target columns:

| Column | Type | Notes |
|---|---|---|
| `event_key` | `String` | UNIQUE, required |
| `selected_live_plan_entry_id` | `Int?` | FK -> `live_plan_entries.id`; UI'da seçilen entry |
| `schedule_date` | `Date` | UI TARİH; required |
| `schedule_time` | time-like scalar | UI SAAT; required |
| `team_1_name` | `String` | selected entry'den kopya |
| `team_2_name` | `String` | selected entry'den kopya |
| `channel_1_id` | `Int?` | FK -> `channels.id` |
| `channel_2_id` | `Int?` | FK -> `channels.id` |
| `channel_3_id` | `Int?` | FK -> `channels.id` |
| `commercial_option_id` | `Int?` | FK -> `schedule_commercial_options.id` |
| `logo_option_id` | `Int?` | FK -> `schedule_logo_options.id` |
| `format_option_id` | `Int?` | FK -> `schedule_format_options.id` |

Duplicate channel rule:

```text
channel_1_id, channel_2_id, channel_3_id aynı satırda aynı channel id'yi tekrar edemez.
NULL değerler serbesttir.
```

Eski canonical olmayan alanlar:

- `schedules.metadata` DROP.
- `schedules.usage_scope` DROP.
- `schedules.start_time` DROP.
- `schedules.end_time` DROP.
- `schedules.channel_id` DROP.

Destructive drop/delete migration inventory + usage grep sonrasında ve yeni schema/backend/frontend path çalışır hale geldikten sonra yapılır.

---

## §5 — Lookup Tables

Yeni schedule lookup tabloları:

| Table | Used by |
|---|---|
| `schedule_commercial_options` | `schedules.commercial_option_id` |
| `schedule_logo_options` | `schedules.logo_option_id` |
| `schedule_format_options` | `schedules.format_option_id` |

Standart lookup table pattern'i M5-B4 ile aynı olmalı:

```text
id, label, active, sort_order, created_at, updated_at, deleted_at
```

Unique:

```text
LOWER(label) unique WHERE deleted_at IS NULL
```

UI yönetimi:

- Mevcut lookup management UI genişletilir.
- Yeni grup adı: **Yayın Planlama**.
- Menü adı: **Lookup Yönetimi**.
- Route şimdilik `/admin/live-plan-lookups` kalır.

---

## §6 — Channel Propagation

Schedule kanal slotları aynı event'e ait tüm live-plan entry'lere birebir yansır:

```text
schedules.channel_1_id -> live_plan_entries.channel_1_id
schedules.channel_2_id -> live_plan_entries.channel_2_id
schedules.channel_3_id -> live_plan_entries.channel_3_id
```

Trigger noktaları:

1. Schedule create/update:
   - `schedule` satırı yazılır.
   - Aynı transaction içinde aynı `event_key`'e sahip tüm `live_plan_entries` kanal slotları güncellenir.

2. LivePlanEntry create:
   - Aynı `event_key` için schedule varsa schedule kanal slotları yeni `live_plan_entries` satırına kopyalanır.

Bu sync background job değil, service-level transaction davranışıdır.

---

## §7 — Ingest Boundaries

Ingest veri kaynakları:

- Canlı Yayın Plan -> Ingest: sadece **isim + saat**.
- Stüdyo Planı -> Ingest: sadece **isim + saat**.
- Schedule/Yayın Planlama -> Ingest: **veri akışı yok**.

Ingest'e kopyalanmayacak alanlar:

- teknik detay
- kanal
- ticari
- logo
- format
- transmisyon segmentleri

Transmisyon süreleri `live_plan_transmission_segments` içinde kalır. Teknik detaylar `live_plan_technical_details` içinde kalır.

---

## §8 — JSON Cleanup

Locked hedef:

- Canlı Yayın Plan için JSON/metadata canonical kaynak olmayacak.
- Eski live-plan JSON dataları migrate edilmez.
- `schedules.usage_scope='live-plan'` kayıtları migration ile silinir.
- Eski live-plan schedule satırlarına bağlı `bookings`, `incidents`, `timeline_events` kayıtları cascade ile silinebilir. Veri kaybı bilinçli kabul; test/production ayrımı garanti edilmez.
- `ingest_plan_items.sourceType='live-plan'` eski bağlantılı kayıtlar silinir.
- `schedules.metadata`, `schedules.usage_scope`, `schedules.start_time`, `schedules.end_time`, `schedules.channel_id` drop hedefidir.

Implementation guard:

1. `rg "metadata|usageScope|usage_scope|channelId|channel_id|startTime|start_time|endTime|end_time" apps/api apps/web packages/shared`
2. DB inventory:
   - `schedules.usage_scope` distribution.
   - `schedules.metadata` non-null count and sample keys.
   - `bookings/incidents/timeline_events` FK dependency counts for live-plan schedule rows.
   - `ingest_plan_items.sourceType='live-plan'` count and linkage state.
3. Kod structured kolonlara geçmeden drop migration yazılmaz.

---

## §9 — Implementation Split

Önerilen PR sırası:

### SCHED-B1 — Requirements + inventory

- Bu doc.
- Grep + DB inventory.
- Drop listesi kesinleştirme.

### SCHED-B2 — Schema foundation

- `schedules.event_key`.
- `selected_live_plan_entry_id`.
- `schedule_date` / `schedule_time`.
- `team_1_name` / `team_2_name`.
- `channel_1_id/channel_2_id/channel_3_id`.
- schedule lookup tabloları.
- `live_plan_entries.source_type`.
- `live_plan_entries.event_key`.
- `live_plan_entries.channel_1_id/channel_2_id/channel_3_id`.
- CHECK/unique/index constraints.

### SCHED-B3 — API/service rewiring

- Schedule create/update new field set.
- Event selection from `live_plan_entries`.
- Manual content create writes `live_plan_entries`.
- Channel propagation transaction.
- LivePlanEntry create copies schedule channel slots when event_key exists.

### SCHED-B4 — Frontend rewiring

- "Live-Plan (yeni)" nav kaldırılır.
- "Canlı Yayın Plan" structured `live_plan_*` screen'e gider.
- `/schedules` kullanıcı etiketi "Yayın Planlama" olur.
- Schedule screen: TARİH/TAKIM/SAAT/KANAL 1-3/TİCARİ/LOGOLAR/FORMAT.
- Content selection: OPTA'dan Seç / Manuel İçerik.
- Lookup Yönetimi label update + Yayın Planlama group.

### SCHED-B5 — Cleanup migration

- Eski live-plan schedule rows delete.
- Cascade bağlı kayıtlar temizlenebilir.
- Eski `ingest_plan_items.sourceType='live-plan'` kayıtları delete.
- `schedules.metadata` drop.
- `schedules.usage_scope` drop.
- `schedules.start_time` / `schedules.end_time` drop.
- `schedules.channel_id` drop.
- Dead code cleanup.

Cleanup migration en sona kalır. Schema/backend/frontend yeni path çalışmadan destructive drop/delete yapılmaz.

---

## §10 — Open Inventory Questions

Implementation öncesi cevaplanacak:

1. `schedules.metadata` currently used by any path var mı?
2. `schedules.start_time/end_time` mevcut kodda hangi path'lerde okunuyor?
3. `bookings`, `incidents`, `timeline_events` live-plan schedule rows'a bağlı kaç kayıt var?
4. `ingest_plan_items.sourceType='live-plan'` satır sayısı ve linkage state nedir?
5. `live_plan_entries` içinde existing kayıtlar için `source_type` / `event_key` backfill stratejisi nedir?
6. Schedule lookup seed değerleri ne olacak?
7. Existing `/schedules` frontendinde hangi eski alanlar dead code olarak temizlenecek?

---

## §11 — K1-K32 Summary

| K | Konu | Karar |
|---|---|---|
| K1 | `schedules.metadata` | DROP |
| K2 | `schedules.usage_scope` | DROP + eski `live-plan` kayıt DELETE |
| K3 | `schedules.start_time/end_time` | DROP; canonical = `schedule_date` + `schedule_time` |
| K4 | `schedules.channel_id` | DROP; 3 slot replace |
| K5 | Kanal slot sayısı | Max 3, duplicate yasak |
| K6 | `team_1_name/team_2_name` | `live_plan_entries`'ten kopya |
| K7 | İçerik seçimi | 2 sekme: OPTA / Manuel, ikisi de `live_plan_entries` |
| K8 | Manuel İçerik Ekle | Doğrudan `live_plan_entries` yazar |
| K9 | `schedules.event_key` | UNIQUE |
| K10 | `selected_live_plan_entry_id` | Tutulur; propagation `event_key` üzerinden |
| K11 | Kanal değişimi | Tx-içi tüm matching `live_plan_entries` propagation |
| K12 | Yeni live_plan entry | `event_key` match ederse schedule kanal slot kopya |
| K13 | Schedule lookup | 3 ayrı tablo |
| K14 | Lookup yönetimi | Mevcut UI'ya entegre |
| K15 | Sol menü | Canlı Yayın Plan + Yayın Planlama |
| K16 | Lookup grup adı | Yayın Planlama |
| K17 | UI kolonlar | TARİH, TAKIM 1/2, SAAT, KANAL 1/2/3, TİCARİ, LOGOLAR, FORMAT |
| K18 | `source_type` | OPTA / MANUAL |
| K19 | event_key OPTA | `opta:<optaMatchId>` |
| K20 | event_key Manual | `manual:<uuid>` |
| K21 | event_key match | `match:<matchId>` rezerve |
| K22 | Eski live-plan schedule kayıt | Migration ile DELETE |
| K23 | Cascade bağlı kayıtlar | Veri kaybı bilinçli kabul |
| K24 | `ingest_plan_items.sourceType='live-plan'` | DELETE; M5-B11'de FK ile doğru bağlantı |
| K25 | Live-Plan -> Ingest | Sadece isim + saat |
| K26 | Studio Plan -> Ingest | Sadece isim + saat |
| K27 | Schedule -> Ingest | Akış yok |
| K28 | Canlı Yayın Plan teknik detay | `live_plan_technical_details` |
| K29 | Transmisyon süreleri | `live_plan_transmission_segments`; Schedule'da yok |
| K30 | Ticari/Logolar/Format | Opsiyonel |
| K31 | Kanal seçimi | Opsiyonel |
| K32 | Required | `event_key` + `schedule_date` + `schedule_time` |

---

## §12 — One-Line Architecture

Live-plan (event + operasyon + teknik detay; structured DB; JSON yok) `<->` `event_key` (UNIQUE on schedule, N on live-plan) `<->` Schedule/Yayın Planlama (yayın akışı; 3 kanal slot + 3 lookup; teknik detay tutmaz) -> Ingest (live-plan + studio-plan'dan isim+saat okur; Schedule'dan veri almaz; ana event kaynağı değildir). Eski `schedules.metadata`, `usage_scope='live-plan'` ve bağlı eski kayıtlar cleanup scope'undadır.
