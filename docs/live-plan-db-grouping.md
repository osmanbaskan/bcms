# Canlı Yayın Planı — DB Grouping Referansı

**Amaç**: Canlı Yayın Planı ekranındaki tüm bilgilerin hangi tabloda/kolonda tutulduğunu,
hangi domain grubuna ait olduğunu netleştiren referans doküman. Sonraki sınıflandırma
revizyonu için zemin.

**Tarih**: 2026-05-12
**Kapsam**: read-only analiz (kod değişikliği YOK)
**Kaynaklar**: `prisma/schema.prisma`, `live-plan.service.ts`, `*.routes.ts`,
`packages/shared/src/types/live-plan.ts`, `schedule-list.component.ts`,
`live-plan-entry-edit-dialog.component.ts`, `technical-details.types.ts`

---

## 1. Kısa özet

**Aggregate root**: `live_plan_entries` (Prisma model `LivePlanEntry`). Tek satır
= bir Canlı Yayın Planı kaydı. Tüm UI ekranı (liste, Düzenle, Teknik Düzenle,
Çoğalt, Sil, Ingest projection) bu kaydın etrafında döner.

**Child/lookup/derived tabloları**:

| Tablo | Tip | İlişki | Kardinalite |
|---|---|---|---|
| `live_plan_technical_details` | Child (1:1) | `livePlanEntryId UNIQUE NOT NULL` FK; `ON DELETE CASCADE` | 0..1 |
| `live_plan_transmission_segments` | Child (1:N) | `livePlanEntryId NOT NULL` FK; `ON DELETE CASCADE`; soft-delete | 0..N |
| `matches` | Lookup/master | `LivePlanEntry.matchId` opsiyonel FK; OPTA kimlik kaynağı | 0..1 |
| `leagues` | Derived join | `matches.leagueId` → `leagues.name` (read-only `leagueName`) | 0..1 |
| `schedules` | Cross-domain | `event_key` ile eşli; **kanal slot kaynağı** (K-B3.12 reverse sync) | 0..1 (kanonik) |
| `channels` | Lookup | `channel_1/2/3_id` FK (3 slot) | 0..3 |
| Transmission lookups (16 tablo) | Lookup | `LivePlanTechnicalDetail` içindeki FK'ler (modulation, video coding, IRD, fiber, polarization, vb.) | N:1 |
| Live-plan lookups (8 tablo) | Lookup | location/usage/region/language/off-tube/equipment/company/feed-related | N:1 |
| `ingest_jobs` | İlgili domain | `ingestJobs.targetId` → `LivePlanEntry.id`; ingest projection için bilgi alanı | 0..N |
| `ingest_plan_items` | İlgili domain | `sourceKey='liveplan:<entryId>'` ile eşli (string convention; FK yok) | 0..1 |
| `audit_logs` | Projection | Prisma `$extends` audit plugin ile otomatik (tüm CRUD) | N:1 |
| `outbox_events` | Projection | `live_plan.created/updated/deleted` shadow events | N:1 |

---

## 2. Tablo bazlı harita

### 2.1 `live_plan_entries` — aggregate root

| Kolon | Tip | Domain rolü | Notlar |
|---|---|---|---|
| `id` | PK | Sistem | Autoincrement |
| `title` | varchar(500) | Yayın kaydı temel | "Yayın Adı" — editable |
| `event_start_time` | timestamptz | **Karşılaşma** | "Karşılaşma Başlangıç" (2026-05-12 domain karar) |
| `event_end_time` | timestamptz | **Karşılaşma** (placeholder) | UI'da YOK; backend NOT NULL placeholder (default +2h) |
| `match_id` | int FK → `matches` | OPTA/match | OPTA seçim akışında set; manuel'de null |
| `opta_match_id` | varchar(80) | OPTA external | non-unique; aynı OPTA event'ten çoklu plan mümkün |
| `event_key` | varchar(120) | Cross-domain anahtar | `opta:<id>` veya `manual:<uuid>`; `schedules.event_key` ile eşleşir |
| `source_type` | varchar(20) | OPTA/match | `OPTA` \| `MANUAL` (DB CHECK) |
| `status` | enum `LivePlanStatus` | Operasyon | PLANNED / READY / IN_PROGRESS / COMPLETED / CANCELLED |
| `operation_notes` | text | Operasyon | "Açıklama ve Notlar" — editable, max 8000 |
| `team_1_name` | varchar(200) | Karşılaşma | OPTA'dan home team; manuel'de operatör girer |
| `team_2_name` | varchar(200) | Karşılaşma | OPTA'dan away team |
| `channel_1_id` | int FK → `channels` | Kanal slot | Slot 1; K-B3.12 reverse sync |
| `channel_2_id` | int FK → `channels` | Kanal slot | Slot 2 |
| `channel_3_id` | int FK → `channels` | Kanal slot | Slot 3 |
| `created_by` | varchar(100) | Sistem/Audit | Operatör username (Keycloak `preferred_username`) |
| `version` | int default 1 | Sistem | Optimistic locking; If-Match zorunlu (K9) |
| `created_at` / `updated_at` | timestamptz | Sistem | Prisma otomatik |
| `deleted_at` | timestamptz nullable | Sistem | Soft-delete (filter `deletedAt IS NULL`); duplicate hard-delete kullanmaz, route DELETE hard |

**Index'ler**: `(status, event_start_time)`, `(event_start_time)`, `(match_id)`,
`(opta_match_id)`. **Yok**: `event_key` üzerinde unique (kasıtlı; aynı event için
çoklu plan).

### 2.2 `live_plan_technical_details` — 1:1 child (73 domain + 5 sistem kolon)

`livePlanEntryId UNIQUE NOT NULL` ile parent'a bağlı. 6 panel altında gruplanmış
fields (UI tarafından `technical-details.types.ts` LP_FIELD_GROUPS):

| Panel başlığı | UI'daki ad | Kolon sayısı | Karakter |
|---|---|---|---|
| §5.1 Yayın / OB | "Yayın / OB" | 14 | Lokasyon + firma + ekipman + telefon + bölge + kamera adedi |
| §5.2 Ortak (Edit Üst) | "Ortak (Edit Üst)" | 10 | `planned_start_time`, `planned_end_time`, HDVG, Int1/2, OffTube, Dil, 2.Dil, Demod, TIE, Sanal |
| §5.3 IRD / Fiber | "IRD / Fiber" | 5 | IRD1/2/3, Fiber1/2 |
| §5.4 Ana Feed / Transmisyon | "Ana Feed / Transmisyon" | 21 | Feed type, satellite, TXP, sat channel, uplink/downlink frequency + polarization, modulation, roll off, video coding, audio config, key, ISO feed, key type, symbol rate, FEC, bandwidth, uplink fixed phone |
| §5.5 Yedek Feed | "Yedek Feed" | 19 | §5.4 paritesi `backup_*` prefix |
| §5.6 Fiber | "Fiber" | 4 | Fiber company, audio format, video format, bandwidth |

**Toplam**: ~73 domain field. **25 lookup FK scalar-only** — Prisma relation
attribute YOK; reverse field patlamasını (47 array) önlemek için pragmatik
tercih. Service `M5-B9` manuel `findUnique` join ile name resolve eder.

**Sistem kolonları**: `id`, `livePlanEntryId UNIQUE`, `version`, `created_at`,
`updated_at`, `deleted_at`.

**Optimistic locking**: K9 — If-Match header zorunlu (PATCH + DELETE). Parent
entry'nin version'undan **bağımsız** ayrı version.

### 2.3 `live_plan_transmission_segments` — 1:N child

UI'daki "Transmisyon Segmentleri" tablosu (Live Plan Detail sayfası).

| Kolon | Tip | Rol |
|---|---|---|
| `id` | PK | Sistem |
| `live_plan_entry_id` | int FK CASCADE | Parent |
| `feed_role` | varchar(20) | `MAIN` \| `BACKUP` \| `FIBER` \| `OTHER` (DB CHECK) |
| `kind` | varchar(20) | `TEST` \| `PROGRAM` \| `HIGHLIGHTS` \| `INTERVIEW` \| `OTHER` (DB CHECK) |
| `start_time` / `end_time` | timestamptz | Segment penceresi |
| `description` | text nullable | Operasyon notu |
| `created_at` / `updated_at` / `deleted_at` | timestamptz | Sistem (soft-delete) |

**Version kolonu YOK** (T9): last-write-wins; parent entry'nin version'u
operasyonel concurrency için yeterli kabul.

### 2.4 `matches` — OPTA master

`LivePlanEntry.matchId` opsiyonel FK. OPTA seçim akışında doldurulur; manuel
'da null.

| Kolon | Rol UI'da |
|---|---|
| `optaUid` (unique) | OPTA event identifier; `event_key='opta:<optaUid>'` üretir |
| `homeTeamName` / `awayTeamName` | `team1Name` / `team2Name` kopya kaynağı |
| `matchDate` | `eventStartTime` kopya kaynağı |
| `leagueId` → `leagues.name` | "Lig" kolonu (read-only join) |

### 2.5 `schedules` — cross-domain partner

`schedules.event_key` ile `live_plan_entries.event_key` eşleşir. **K-B3.12
reverse sync**: schedule broadcast flow'unda kanal slot atanırsa, live-plan
entry'nin kanal slot'u **schedule'dan kanonik** çekilir (live-plan oluşturulurken
veya duplicate edilirken). live-plan update channel'ları schedule'a forward sync
eder (2026-05-11).

UI tarafından gözükmeyen ama bağlantılı: bir live-plan entry'nin broadcast
schedule'u var mı (`hasBroadcastSchedule`) bilgisi ingest projection'da kullanılır.

### 2.6 Lookup tabloları (24 adet)

Hepsi standart 6-kolon: `id`, `label`, `active`, `sort_order`, `created_at`,
`updated_at`, `deleted_at` (soft-delete).

**Transmission family** (16):
`transmission_satellites`, `transmission_irds`, `transmission_fibers`,
`transmission_int_resources`, `transmission_tie_options`,
`transmission_demod_options`, `transmission_virtual_resources`,
`transmission_feed_types`, `transmission_modulation_types`,
`transmission_video_codings`, `transmission_audio_configs`,
`transmission_key_types`, `transmission_polarizations`,
`transmission_fec_rates`, `transmission_roll_offs`,
`transmission_iso_feed_options`.

**Live-plan family** (6):
`live_plan_locations`, `live_plan_usage_locations`, `live_plan_regions`,
`live_plan_languages`, `live_plan_off_tube_options`, `live_plan_equipment_options`
(polymorphic: JIMMY_JIB / STEADICAM / IBM).

**Cross-domain** (3):
`technical_companies` (polymorphic: OB_VAN / GENERATOR / SNG / CARRIER / FIBER),
`fiber_audio_formats`, `fiber_video_formats`.

**Channel** (1): `channels` (canonical playout master).

### 2.7 Audit / outbox

- `audit_logs`: Prisma `$extends` plugin tüm CRUD üzerinde `entity_type='LivePlanEntry'` (+ `LivePlanTechnicalDetail`, `LivePlanTransmissionSegment` ayrı entity types) ile otomatik kayıt.
- `outbox_events`: shadow event'ler — `live_plan.created`, `live_plan.updated`, `live_plan.deleted`. Phase 2 status `published` (poller pick etmez). Duplicate akışında `live_plan.created` + payload `{ livePlanEntryId, duplicatedFromId }`.

---

## 3. UI alanı → DB alanı mapping tablosu

### 3.1 Schedule-list tablo (Canlı Yayın Planı listesi `/schedules`)

| Görünen başlık | Frontend property | API response field | DB tablo / kolon | Editable | Dialog |
|---|---|---|---|---|---|
| Karşılaşma Başlangıç | `s.startTime` | `eventStartTime` | `live_plan_entries.event_start_time` | Evet | Düzenle |
| Yayın Adı | `s.title` | `title` | `live_plan_entries.title` | Evet | Düzenle |
| Transmisyon Başlangıç | `s.technicalDetails.plannedStartTime` | `technicalDetails.plannedStartTime` | `live_plan_technical_details.planned_start_time` | Evet | Düzenle (+ Teknik Düzenle) |
| Transmisyon Bitiş | `s.technicalDetails.plannedEndTime` | `technicalDetails.plannedEndTime` | `live_plan_technical_details.planned_end_time` | Evet | Düzenle (+ Teknik Düzenle) |
| Mod Tipi / Coding Tipi | `s.technicalDetails.modulationTypeName` / `videoCodingName` | join name | `live_plan_technical_details.modulation_type_id` / `video_coding_id` (FK) | Evet | Teknik Düzenle (Ana Feed) |
| IRD | `ird1Name` / `ird2Name` / `ird3Name` | join name | `live_plan_technical_details.ird1/2/3_id` (FK) | Evet | Teknik Düzenle (IRD/Fiber) |
| Fiber | `fiber1Name` / `fiber2Name` | join name | `live_plan_technical_details.fiber1/2_id` (FK) | Evet | Teknik Düzenle (IRD/Fiber) |
| Demod | `demodName` | join name | `live_plan_technical_details.demod_id` (FK) | Evet | Teknik Düzenle (Ortak) |
| Kayıt Yeri | `formatRecordingPorts(s)` | ingest projection üzerinden | `ingest_plan_item_ports.port_name` (cross-domain) | Hayır (ingest panelinden) | — |
| TIE | `tieName` | join name | `live_plan_technical_details.tie_id` (FK) | Evet | Teknik Düzenle (Ortak) |
| Sanal | `virtualResourceName` | join name | `live_plan_technical_details.virtual_resource_id` (FK) | Evet | Teknik Düzenle (Ortak) |
| HDVG | `hdvgResourceName` | join name | `live_plan_technical_details.hdvg_resource_id` (FK) | Evet | Teknik Düzenle (Ortak) |
| Int | `int1ResourceName` / `int2ResourceName` | join name | `int1/2_resource_id` (FK) | Evet | Teknik Düzenle (Ortak) |
| Off Tube | `offTubeName` | join name | `off_tube_id` (FK) | Evet | Teknik Düzenle (Ortak) |
| Dil | `languageName` / `secondLanguageName` | join name | `language_id` / `second_language_id` (FK) | Evet | Teknik Düzenle (Ortak) |
| Kanal | `channelTriplet(s)` | `channel1/2/3Id` | `live_plan_entries.channel_1/2/3_id` (FK) | Evet | Düzenle (3 mat-select) |
| Lig | `s.leagueName` | derived join | `matches.league.name` | Hayır (OPTA seçimine bağlı) | — |
| Açıklama ve Notlar | `s.operationNotes` | `operationNotes` | `live_plan_entries.operation_notes` | Evet | Düzenle |
| (Aksiyonlar) | — | — | — | — | Düzenle / Teknik Düzenle / Çoğalt / Sil |

### 3.2 Düzenle dialog (`live-plan-entry-edit-dialog.component.ts`)

| Görünen label | Form alanı | API request field | DB alanı | Editable |
|---|---|---|---|---|
| Yayın Adı | `form.title` | `title` | `live_plan_entries.title` | Evet |
| Lig | (readonly) | `leagueName` (read-only) | `matches.league.name` join | Hayır |
| Kanal 1 / 2 / 3 | `form.channel1Id` / `2Id` / `3Id` | `channel1/2/3Id` | `live_plan_entries.channel_1/2/3_id` | Evet (3 slot bağımsız) |
| Karşılaşma Tarihi | `form.startDate` (`<input type="date">`) | `eventStartTime` (compose) | `live_plan_entries.event_start_time` | Evet |
| Karşılaşma Başlangıç (saat) | `form.startTime` (`<input type="time">`) | `eventStartTime` (compose) | `live_plan_entries.event_start_time` | Evet |
| Transmisyon Başlangıç Tarihi | `form.plannedStartDatePickerValue` (MatDatepicker) | `plannedStartTime` (compose) | `live_plan_technical_details.planned_start_time` | Evet |
| Transmisyon Başlangıç Saati | `form.plannedStartTime` | `plannedStartTime` (compose) | `live_plan_technical_details.planned_start_time` | Evet |
| Transmisyon Bitiş Tarihi | `form.plannedEndDatePickerValue` | `plannedEndTime` (compose) | `live_plan_technical_details.planned_end_time` | Evet |
| Transmisyon Bitiş Saati | `form.plannedEndTime` | `plannedEndTime` (compose) | `live_plan_technical_details.planned_end_time` | Evet |
| Açıklama ve Notlar | `form.operationNotes` | `operationNotes` | `live_plan_entries.operation_notes` | Evet |

**Önemli**: Düzenle dialog tek bir UI ekranında **2 farklı backend kaynağı**'na
yazar:
- Entry alanları (`title`, `eventStartTime`, `operationNotes`, `channel*`) → `PATCH /api/v1/live-plan/:id` (entry version)
- Teknik plan zamanı (`plannedStartTime`, `plannedEndTime`) → `PATCH /api/v1/live-plan/:entryId/technical-details` (technical details version)

İki ayrı If-Match version; iki ayrı 412 ihtimali.

### 3.3 Teknik Düzenle dialog (`technical-details-form.component.ts`, 6 panel × ~73 alan)

Tüm alanlar `LP_FIELD_GROUPS` üzerinden render edilir. Her field:
- `key`: `live_plan_technical_details.<column>` adı
- `label`: UI Türkçe başlık
- `kind`: `fk` \| `string` \| `int` \| `datetime`
- `lookupType`: ilgili lookup tablosu (FK ise)
- `polymorphicType`: type-polymorphic lookup'larda filter (`OB_VAN`, `JIMMY_JIB`, vb.)

73 field detayı için `apps/web/src/app/features/live-plan/live-plan-detail/technical-details.types.ts:181-294` bkz.

### 3.4 Liste ekran cross-domain alanları (read-only)

| Alan | Kaynak |
|---|---|
| **Kayıt Yeri** ("Kayıt Yeri" kolonu) | `ingest_plan_item_ports.port_name` — ingest plan satırının (`sourceKey='liveplan:<entryId>'`) ports tablosundan |
| **Hafta** ("Lig / Hafta" kolonu) | (bilgi: `matches.week_number` mevcut, ama UI'da net olarak görünmüyor — hafta numarası gösterimi aktif değil) |
| **Lig** | `matches.league.name` (derived join) |

---

## 4. Domain grupları (öneri)

### 4.1 Karşılaşma Bilgisi (Match domain)
Veri sahibi: `matches` (OPTA master) + `live_plan_entries` üzerine kopya.

- `team_1_name`, `team_2_name` → karşılaşma tarafları
- `event_start_time` → karşılaşma başlangıç saati (kanonik)
- `event_end_time` → **placeholder** (karşılaşma süresi UI'da yok; backend NOT NULL +2h)
- `match_id`, `opta_match_id` → OPTA kimlik
- `leagueName` → derived join, read-only
- `source_type` → veri kaynağı (OPTA \| MANUAL)

### 4.2 Yayın Kaydı Bilgisi (Plan meta)
Veri sahibi: `live_plan_entries` (entry tablosu).

- `title` → yayın adı
- `status` → plan durumu (PLANNED…)
- `operation_notes` → operasyon notu
- `event_key` → cross-domain anahtar (schedules eşleşmesi)
- `created_by`, `created_at`, `updated_at`, `version`, `deleted_at` → sistem alanları

### 4.3 Transmisyon Zamanı (Planlama)
Veri sahibi: `live_plan_technical_details` (1:1 child).

- `planned_start_time`, `planned_end_time` → transmisyon penceresi (UI'daki "Transmisyon Başlangıç/Bitiş")

**NOT**: Şu an entry root'unda DEĞİL; child satırda yaşıyor. Düzenle dialog'u bu
iki alanı entry update'iyle aynı UX akışında ama farklı endpoint'le yazar.

### 4.4 Kanal Bilgisi
Veri sahibi: `live_plan_entries` (3 slot) + cross-sync: `schedules`.

- `channel_1_id`, `channel_2_id`, `channel_3_id` → 3-slot playout kanonik
- K-B3.12: schedule canonical (schedule var ise); live-plan PATCH ile schedule'a forward sync.

### 4.5 Teknik Planlama (Technical operasyon)
Veri sahibi: `live_plan_technical_details` (1:1 child).

73 alan; 6 panel:
1. **Yayın / OB** (14) — Yayın yeri, OB van, jeneratör, kamera, telefon, bölge
2. **Ortak** (10) — Transmisyon zamanı (3.3 paylaşıyor), HDVG, Int, OffTube, Dil, Demod, TIE, Sanal
3. **IRD / Fiber** (5) — 3 IRD + 2 Fiber slot
4. **Ana Feed / Transmisyon** (21) — Feed tipi, uydu, frekans, modulation, key, sembol oranı, vb.
5. **Yedek Feed** (19) — §4 paritesi `backup_*`
6. **Fiber** (4) — Fiber firma, format, bandwidth

### 4.6 Kaynak / Feed Bilgisi (overlap with §4.5)
"Kaynak / Feed" UI'da ayrı bir başlık olarak görünmüyor — Ana Feed + Yedek Feed +
Fiber panelleri zaten bunu içeriyor. Lookup tarafında ayrı bir "feed catalog"
domain'i yok; lookup'lar uydu/polarization/modulation çapraz kullanım.

### 4.7 Operasyon Notları
Veri sahibi: `live_plan_entries.operation_notes` (text).

Tek alan; Düzenle dialog'unda standalone textarea. Plan-wide free-form not.
Segment-level not için `live_plan_transmission_segments.description` ayrı domain.

### 4.8 Sistem / Audit alanları
- `id`, `created_at`, `updated_at`, `deleted_at`, `version`, `created_by`
- Audit: `audit_logs` projeksiyon (Prisma `$extends`)
- Outbox: `outbox_events` shadow (`live_plan.created/updated/deleted`)
- Optimistic locking: parent ve child satırlar ayrı version'lar

### 4.9 Ingest bağlantısı (cross-domain bilgi, FK YOK)
- `ingest_jobs.target_id` → entry id (Phase A1 FK ile bağlı; SET NULL)
- `ingest_plan_items.source_key='liveplan:<entryId>'` (string convention; FK yok)
- "Kayıt Yeri" kolonu, ingest projection ile zenginleştirilmiş read-only alan

---

## 5. Şu anki sorunlu / karışık alanlar

### 5.1 `event_start_time` vs `planned_start_time`
**Sorun**: İkisi de "başlangıç zamanı" gibi gözüküyor.
**Karar (2026-05-12)**:
- `eventStartTime` = **Karşılaşma Başlangıç** (futbol maçının başladığı saat;
  OPTA `matchDate`'dan kopya).
- `plannedStartTime` = **Transmisyon Başlangıç** (operasyonun başladığı saat;
  pre-match key + warm-up dahil; karşılaşmadan ~30 dk önce).
- İki kaynak ayrı tablolarda yaşıyor: entry vs technical details.

### 5.2 `event_end_time` placeholder
**Sorun**: UI'da "Karşılaşma Bitiş Saati" alanı **YOK**, ama DB kolonu NOT NULL.
Backend `eventStartTime + 2h` default ile doldurur (B3b refine: start-only
update'i kabul eder, end auto-extend; service `autoEndForStartOnly`).
**Risk**: 132 dk üzeri uzayan maçlar (uzatma, golden goal) için end şişer; ama
operasyonel anlam yok (transmission window canonical).
**Önerim**: `eventEndTime` ya kolonu nullable yapılmalı (migration) ya da
"karşılaşma süresi" ayrı domain alanı olmalı. Şu an cargo column.

### 5.3 `match.matchDate` vs `eventStartTime`
**İlişki**: OPTA seçim akışında `eventStartTime = match.matchDate` kopya.
Sonradan ikisi **bağımsız** yaşar — operatör eventStartTime'ı değiştirebilir
(maç ertelendi senaryosu); match.matchDate OPTA tarafından güncellenir, fakat
live-plan otomatik yansımaz.
**Risk**: Drift ihtimali; reconcile mekanizması yok.

### 5.4 Schedule channel slot reverse sync (K-B3.12)
**Davranış**: Aynı `event_key`'li schedule varsa, live-plan channel'ları
schedule'dan **read-time** çekilmez — duplicate ve create akışlarında
**write-time** kopya. Sonradan live-plan PATCH channel'ları forward sync ile
schedule'a yazar (K-B3.21).
**Karışıklık**: İki tablo aynı bilgiyi tutar; "kanonik" hangisi?
**Şu anki uygulama**: Schedule kanonik kabul (create/duplicate'te); ama live-plan
update'i schedule'a yansır (forward sync). Net bir kanonik tek-kaynak yok;
"son yazan kazanır" iki tablo arasında.

### 5.5 Duplicate snapshot davranışı (2026-05-13 revize)
**Yeni davranış** (`83a700c`): Çoğalt artık snapshot kopya — entry alanları +
operationNotes + `live_plan_technical_details` satırı tüm payload ile yeni row
olarak kopyalanır. Kaynak/kopya bağımsız yaşar. Segments scope dışı (V1).
**Açık nokta**: `live_plan_transmission_segments` kopya edilmiyor; gelecekte
operatör 1:N segment'leri elden kopya etmek istiyor mu? Karar V2'ye ertelendi.

### 5.6 `technicalDetails` 1:1 child mı, virtual extension mu?
**Mevcut model**: Ayrı tablo, ayrı version, ayrı If-Match, ayrı CRUD endpoint
(`/api/v1/live-plan/:entryId/technical-details`). Ama UI Düzenle dialog'unda 2
alan (`plannedStart/EndTime`) entry alanlarıyla aynı form'da editleniyor —
kullanıcının bakış açısıyla "tek kayıt".
**Karışıklık**: Backend 2 endpoint, 2 version, 2 audit entity; frontend 1 form.
İki ayrı 412 ihtimali var.

### 5.7 `metadata` legacy alan yok
`live_plan_entries.metadata` Madde 5 M5-B4 ile **DROP edildi**. Eski code/audit
referansları kaldırıldı; JSON canonical YASAK. Bu doğru durumda; sadece tarihi
dokümantasyon için not.

---

## 6. Önerilen yeniden gruplandırma

Aşağıdaki öneriler **şimdilik karar değil**; kullanıcının revizyonu için zemin.

### 6.1 Domain ayrımı net olsun

| Grup | Mevcut tablo | Öneri |
|---|---|---|
| Karşılaşma kimlik | `matches` + entry kopyaları (`team_*`, `event_start_time`, `opta_match_id`) | **Karşılaşma** olarak gruplan; UI'da ayrı kart/panel |
| Yayın planı meta | `live_plan_entries` (title, status, notes, key) | **Plan Bilgisi** |
| Kanal | `live_plan_entries.channel_*` | **Kanal** olarak ayrı kart; 3 slot net göster |
| Transmisyon zamanı | `live_plan_technical_details.planned_*` | **Transmisyon Zamanı** olarak ayrı kart; teknik alt-paneliyle birleştirme **iptal** (operasyonel mantıkta zaman ≠ teknik) |
| Teknik detay | `live_plan_technical_details.*` (zaman hariç) | **Teknik** olarak 6 panel altında kalsın |
| Operasyon notu | `live_plan_entries.operation_notes` | **Operasyon Notu** olarak ayrı (zaten öyle) |

### 6.2 Aynı grupta kalmalı
- 3 kanal slotu (channel_1/2/3) → tek grup; bağımsız edit ama tek konsept
- IRD 1/2/3 → tek grup
- Fiber 1/2 → tek grup
- Int 1/2 → tek grup
- Dil + 2.Dil → tek grup
- Ana Feed + Yedek Feed → 2 grup, ama "Feed" üst başlığı altında ikiz panel
- Fiber paneli (4 alan) → kendi grubunda kalsın; "Feed" üst başlığı altında 3.üncü sub-panel olabilir

### 6.3 Ayrılmalı
- **plannedStartTime/plannedEndTime ⇒ Transmisyon Zamanı** (Teknik §5.2 "Ortak"
  panelinden çıkar; ayrı kart). Operatör UX'i şu an doğru ama domain karışıklığı
  var: zaman teknik konfigürasyondan değil operasyon planından (Düzenle'de
  yaşamalı).
- **Karşılaşma alanları ⇒ ayrı kart**: title (yayın adı) ≠ team1/team2 (karşılaşma
  tarafları); aynı dialog'da olsa bile vizüel ayrım yararlı.
- **Lig / Hafta**: Şu an "Lig" + "Hafta" tek kolon; `matches.week_number` UI'a
  expose edilmiyor — ayrılsın veya birleştir net göster.

### 6.4 Derived / projection olmalı
- `leagueName` — şu an Match.league join (doğru); kolon değil derived
- `Kayıt Yeri` — şu an ingest projection (doğru); FK YOK kalsın
- `hasBroadcastSchedule` — derived flag (event_key match var mı); ingest tab
  bilgisi olarak doğru projection
- 14 FK için `<lookup>Name` resolved name → derived (mevcut pattern: backend
  batch fetch 10 lookup; doğru)

### 6.5 Migration gerektirebilecek revizeler (karar bekliyor; öneri)
- `event_end_time` NULLABLE veya DROP (cargo column problem; §5.2)
- `live_plan_technical_details.planned_start_time/end_time` entry root'una taşın
  (1:1 ile aynı PK; semantically entry-level zaman) — büyük refactor, ileride
- `transmission_segments.version` ekle (T9 deferred decision; concurrency için)

---

## 7. Uygulama stratejisi

### 7.1 Sadece frontend label/layout (düşük risk)
- Düzenle dialog'u kart bazlı (Karşılaşma / Plan / Kanal / Transmisyon / Notlar) ayır
- Schedule-list tablo başlıklarını gruplu thead yap (Karşılaşma + Plan + Teknik + Notlar)
- Teknik Düzenle 6 paneli yeniden adlandır/sıralandır (LP_FIELD_GROUPS tek noktadan)
- "Transmisyon Zamanı" alanlarını Teknik Düzenle §5.2'den taşıyıp Düzenle'de ayrı kart yap (zaten Düzenle'de var; Teknik tarafından kaldır → operasyon UX netleşir)

**Migration**: yok
**Test**: Karma (UI dialog testleri) + Playwright görsel
**Risk**: Düşük; backend dokunulmaz

### 7.2 API response genişletmesi (orta risk)
- Liste response'una `matches.week_number` join ekle ("Lig / Hafta" gerçek değer)
- Liste response'una `live_plan_technical_details.broadcast_location_id` resolved name ekle (Yayın Yeri liste'de görünsün)
- Liste response'una segment count derived ekle (kaç segment var bilgisi)

**Migration**: yok
**Test**: Backend integration + frontend birim (mock response)
**Risk**: Orta; backend batch fetch sayısı artar; N+1 yok ama lookup batch 10 → 12

### 7.3 Migration gerektiren (yüksek risk; ayrı PR önerisi)
- `event_end_time` nullable migration (NOT NULL DROP)
- `live_plan_technical_details.planned_*` entry'e taşı (büyük; B6+ planlanmalı)
- `live_plan_transmission_segments.version` ekle (T9)
- `event_key` üzerinde compound unique (eventKey + deletedAt) — aktif yalnız 1 kural

**Migration**: var (her biri ayrı)
**Test**: Migration apply + tüm live-plan integration paketi (130/130)
**Risk**: Yüksek; runtime DB ile lokal DB drift; explicit onay zorunlu

### 7.4 Riskli alanlar ve test ihtiyacı
- **Channel reverse sync (K-B3.12)**: schedule + live-plan eş zamanlı update senaryosunda hangisi kanonik? Smoke + chaos test gerekir
- **OPTA late-arrival**: matchDate sonradan değişirse live-plan'ın eventStartTime'ı drift eder; reconcile akışı tasarlanmalı (yoksa bilinçli karar)
- **Çoğalt + Teknik Düzenle race**: snapshot duplicate sonrası source/dup arasında 1 saniye ara ile update — concurrent operatörler için lock model henüz test edilmedi
- **Segments duplicate**: V2 kapsamı; segments operasyonel olarak kopya gerekiyor mu? Operatör görüşü gerekli

---

## 8. Hızlı referans: route ↔ DB ↔ UI

```
GET  /api/v1/live-plan                  → list (entry + leagueName + technicalDetails)
GET  /api/v1/live-plan/:id              → detail
POST /api/v1/live-plan                  → manuel create (eventKey backend forced)
POST /api/v1/live-plan/from-opta        → OPTA seçim akışı (matches.opta_uid kopya)
POST /api/v1/live-plan/:id/duplicate    → snapshot kopya (2026-05-13)
PATCH /api/v1/live-plan/:id             → entry update (If-Match zorunlu)
DELETE /api/v1/live-plan/:id            → hard delete (If-Match zorunlu)

GET    /api/v1/live-plan/:entryId/technical-details  → 1:1 child (null veya 200)
POST   /api/v1/live-plan/:entryId/technical-details  → create (1:1 enforce)
PATCH  /api/v1/live-plan/:entryId/technical-details  → update (If-Match)
DELETE /api/v1/live-plan/:entryId/technical-details  → soft delete (If-Match)

GET    /api/v1/live-plan/:entryId/segments               → list (feedRole/kind filter)
POST   /api/v1/live-plan/:entryId/segments               → create
PATCH  /api/v1/live-plan/:entryId/segments/:segmentId    → update (no If-Match V1)
DELETE /api/v1/live-plan/:entryId/segments/:segmentId    → hard delete

GET  /api/v1/live-plan/lookups/<type>   → lookup listesi (24 type)
```

---

**Bu dokümandan sonraki adım**: Kullanıcı tarafından sınıflandırma revizyonu
yapılırsa, §7 stratejisi üzerinden hangi katmana dokunulacağı netleşir
(frontend-only / API genişletme / migration). Bu dosya o noktada güncellenir
veya ayrı bir REQUIREMENTS dosyasına evrilir.
