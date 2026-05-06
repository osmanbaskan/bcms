# Live-Plan Technical Fields Mapping V1

> **Status**: ✅ Locked (2026-05-06). Implementation pre-req for M5-B4+ (`ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §3.4 K15 + §5 sequence).
> **Tarih**: 2026-05-06
> **Audit referansı**: `BCMS_INDEPENDENT_AUDIT_2026-05-04.md` Madde 5.
> **Cross-reference**: `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` (üst karar log).

## §0 — Status & cross-references

Bu doc Madde 5 strangler programının M5-B3 çıktısı: Canlı Yayın Plan altındaki teknik alanların **structured DB modeline** field-by-field mapping'i. Decision doc K15.1-K15.5 + X1, X2 lock'larının uygulama spec'i.

**İlişkili lock'lar:**
- K15.1: JSON canonical YOK
- K15.2 (revize): Tek `live_plan_technical_details` tablo + segments ayrı 1:N
- K15.3: kategorik=lookup, serbest=scalar, not=text
- K15.4: legacy migration yok, yeni model boş başlar
- K15.5: bu doc ayrı dosya
- X1: fiber audio/video format ayrı lookup
- X2: ingest_plan_items.live_plan_entry_id (transmissions değil entry)

**İptal olan lock'lar** (gelecek developer için):
- Eski K15.2 (Ana/Yedek/Fiber tek transmissions + feedRole) → revize edildi
- W1, W2, W3, W4 (per-feed kolonlar) → tek tabloya geri dönüldü
- `live_plan_transmissions` tablosu **V1'de oluşturulmaz**

---

## §1 — Domain glossary

### `live_plan_technical_details`

> **Live-plan teknik detayları (1:1 ile live_plan_entries)**.
>
> Yayın/OB + Ana Feed + Yedek Feed + Fiber alanlarının tamamı **tek satırda**. Ana Feed kolonları prefix'siz; Yedek Feed `backup_*` prefix; Fiber `fiber_*` prefix. ~80 kolon.

### `live_plan_transmission_segments`

> **Net uydu/transmisyon kullanım segmentleri (1:N from live_plan_entries)**.
>
> Operatörün her gerçek uplink/downlink kullanımını kayıt ettiği satırlar. Maliyet raporu bu satırların `SUM(end_time - start_time)` ile hesaplanır. `feed_role` kolon segment'in hangi feed'e ait olduğunu belirtir.

### Lookup tablolar (25 adet)

> **Kategorik/select-box değerlerin canonical kaynağı.**
>
> Operatör M5-B6 admin UI'sından lookup management ile değer ekler/düzenler. Frontend select box'ları DB'den okur.

---

## §2 — Final mimari özet

```
live_plan_entries (1)
   │
   ├── live_plan_technical_details (1:1)
   │   ├─ Yayın/OB kolonları (14)
   │   ├─ Ana Feed kolonları — prefix'siz (21)
   │   ├─ Yedek Feed kolonları — backup_* prefix (19)
   │   ├─ Fiber kolonları — fiber_* prefix (4)
   │   ├─ Edit dialog'dan event-level: planned_start_time, planned_end_time,
   │   │  hdvg/int1/int2_id, ird1/2/3_id, fiber1/2_id, demod_id, tie_id,
   │   │  virtual_resource_id, language_id, off_tube_id
   │   └─ Diğer scalar: fixed_phone_1/2, camera_count, txp, satChannel, ...
   │
   └── live_plan_transmission_segments (1:N)
       ├─ live_plan_entry_id FK
       ├─ feed_role enum (MAIN/BACKUP/FIBER/OTHER)
       ├─ start_time, end_time (CHECK: end > start)
       ├─ kind enum (TEST/PROGRAM/HIGHLIGHTS/INTERVIEW/OTHER)
       └─ description text

ingest_plan_items
   ├─ live_plan_entry_id FK (X2 — segment değil entry)
   └─ studio_plan_slot_id FK (M5-B12 + XOR CHECK)

Lookup tablolar (25 adet) — §3'te detay
Enum'lar: FeedRole, TransmissionSegmentKind
```

---

## §3 — Lookup tablo listesi (25 adet)

Her lookup tablosu standart yapıda: `(id, label, active, created_at, updated_at)` + (varsa) `type` sütunu polymorphic ayrım için.

| # | Tablo | type sütunu? | Seed kaynağı | Seed satır |
|---|---|---|---|---|
| 1 | `transmission_satellites` | — | **boş** (operatör doldurur) | 0 |
| 2 | `transmission_irds` | — | RESOURCE_OPTIONS `IRD-1..IRD-56` | 56 |
| 3 | `transmission_fibers` | — | RESOURCE_OPTIONS FIBER-1..16 + GBS/DOHA/4G/TVU/YILDIZ | 30 |
| 4 | `transmission_int_resources` | — | INT_OPTIONS (1..12, AGENT, HYRID, IP, ISDN, TEKYON) | 46 |
| 5 | `transmission_tie_options` | — | TIE_OPTIONS hardcoded | 19 |
| 6 | `transmission_demod_options` | — | DEMOD_OPTIONS D1..D9 | 9 |
| 7 | `transmission_virtual_resources` | — | SANAL_OPTIONS '1','2' | 2 |
| 8 | `transmission_feed_types` | — | feedType hardcoded (DVB S, NS3, IP Stream, ...) | 18 |
| 9 | `transmission_modulation_types` | — | modulationType hardcoded (= feedType ile aynı 18 değer; ayrı tablo) | 18 |
| 10 | `transmission_video_codings` | — | videoCoding hardcoded (H265 4:2:2, Mpeg 4:2:0, ...) | 5 |
| 11 | `transmission_audio_configs` | — | **boş** (operatör doldurur via M5-B6) | 0 |
| 12 | `transmission_key_types` | — | hardcoded (BISS Mode-1, BISS Mode-E, Director, Unencrypted) | 4 |
| 13 | `transmission_polarizations` | — | H/V/R/L | 4 |
| 14 | `transmission_fec_rates` | — | **boş** (operatör doldurur — örn. "3/4", "5/6") | 0 |
| 15 | `transmission_roll_offs` | — | %20/%25/%35 | 3 |
| 16 | `transmission_iso_feed_options` | — | **boş** (domain belirsiz; operatör doldurur) | 0 |
| 17 | `technical_companies` | OB_VAN \| GENERATOR \| SNG \| CARRIER \| FIBER | **boş** | 0 |
| 18 | `live_plan_equipment_options` | JIMMY_JIB \| STEADICAM \| IBM | **boş** (domain belirsiz) | 0 |
| 19 | `live_plan_locations` | — | **boş** (broadcastLocation hedefi) | 0 |
| 20 | `live_plan_usage_locations` | — | **boş** | 0 |
| 21 | `live_plan_regions` | — | **boş** | 0 |
| 22 | `live_plan_languages` | — | seed: "Yok" + Türkçe + İngilizce | 3 |
| 23 | `live_plan_off_tube_options` | — | **boş** (domain belirsiz) | 0 |
| 24 | **`fiber_audio_formats`** (X1) | — | **boş** — fiber signal format domain (operatör doldurur) | 0 |
| 25 | **`fiber_video_formats`** (X1) | — | **boş** — fiber signal format domain (operatör doldurur) | 0 |

**Toplam seed**: ~217 satır 25 tabloda.

**Boş başlayan tablolar** (12 adet): satellites, audio_configs, fec_rates, iso_feed_options, technical_companies, equipment_options, locations, usage_locations, regions, off_tube_options, fiber_audio_formats, fiber_video_formats.

→ **Risk**: M5-B7 deploy edilince operatör DB'den seçim yapacak; boş tablolar UI'da boş dropdown gösterir. **M5-B6 lookup management UI'sının operatör tarafından doldurulması M5-B7 öncesi şart**.

---

## §4 — Enum'lar

### FeedRole

```prisma
enum FeedRole {
  MAIN
  BACKUP
  FIBER
  OTHER
}
```

Kullanım: `live_plan_transmission_segments.feed_role` kolon.

### TransmissionSegmentKind

```prisma
enum TransmissionSegmentKind {
  TEST
  PROGRAM
  HIGHLIGHTS
  INTERVIEW
  OTHER
}
```

Kullanım: `live_plan_transmission_segments.kind` kolon.

---

## §5 — Field-by-field mapping (~76 alan)

Sütunlar: **#** | **Frontend key** | **Label** | **Eski yer (legacy)** | **Yeni kolon** | **Tip** | **Notlar**

Hepsi `live_plan_technical_details` tablosunda (1:1 ile entry).

### §5.1 Yayın / OB (14 alan)

| # | Frontend key | Label | Eski yer | Yeni kolon | Tip |
|---|---|---|---|---|---|
| 1 | broadcastLocation | Yayın Yeri | metadata.liveDetails.broadcastLocation | `broadcast_location_id` | FK live_plan_locations |
| 2 | obVanCompany | Obvan Firma | metadata.liveDetails.obVanCompany | `ob_van_company_id` | FK technical_companies(OB_VAN) |
| 3 | generatorCompany | Jeneratör Firma | metadata.liveDetails.generatorCompany | `generator_company_id` | FK technical_companies(GENERATOR) |
| 4 | jimmyJib | Jimmy Jib | metadata.liveDetails.jimmyJib | `jimmy_jib_id` | FK live_plan_equipment_options(JIMMY_JIB) |
| 5 | steadicam | Stedicam | metadata.liveDetails.steadicam | `steadicam_id` | FK live_plan_equipment_options(STEADICAM) |
| 6 | sngCompany | Sng Firma | metadata.liveDetails.sngCompany | `sng_company_id` | FK technical_companies(SNG) |
| 7 | carrierCompany | Taşıyıcı Firma | metadata.liveDetails.carrierCompany | `carrier_company_id` | FK technical_companies(CARRIER) |
| 8 | ibm | Ibm | metadata.liveDetails.ibm | `ibm_id` | FK live_plan_equipment_options(IBM) |
| 9 | usageLocation | Kullanım Yeri | metadata.liveDetails.usageLocation | `usage_location_id` | FK live_plan_usage_locations |
| 10 | fixedPhone1 | Sabit Tel 1 | metadata.liveDetails.fixedPhone1 | `fixed_phone_1` | scalar string |
| 11 | secondObVan | 2. Obvan | metadata.liveDetails.secondObVan | `second_ob_van_id` | FK technical_companies(OB_VAN) |
| 12 | region | Bölge | metadata.liveDetails.region | `region_id` | FK live_plan_regions |
| 13 | cameraCount | Kamera Adedi | metadata.liveDetails.cameraCount | `camera_count` | scalar Int |
| 14 | fixedPhone2 | Sabit Tel 2 | metadata.liveDetails.fixedPhone2 | `fixed_phone_2` | scalar string |

### §5.2 Edit dialog ÜST (event-level operasyonel) — 10 alan

| # | Frontend key | Label | Eski yer | Yeni kolon | Tip | Notlar |
|---|---|---|---|---|---|---|
| 15 | transStart | Trans. Başlangıç | metadata.transStart | `planned_start_time` | DateTime | HH:MM + entry tarih → DateTime conversion (M5-B9 service) |
| 16 | transEnd | Trans. Bitiş | metadata.transEnd | `planned_end_time` | DateTime | DB CHECK: end > start |
| 17 | houseNumber | HDVG | metadata.houseNumber | `hdvg_resource_id` | FK transmission_int_resources |
| 18 | intField | Int | metadata.intField | `int1_resource_id` | FK transmission_int_resources |
| 19 | intField2 | Int 2 | metadata.intField2 | `int2_resource_id` | FK transmission_int_resources |
| 20 | offTube | Off Tube | metadata.offTube | `off_tube_id` | FK live_plan_off_tube_options |
| 21 | language | Dil | metadata.language | `language_id` | FK live_plan_languages |
| 22 | demod | Demod | metadata.liveDetails.demod | `demod_id` | FK transmission_demod_options |
| 23 | tie | TIE | metadata.liveDetails.tie | `tie_id` | FK transmission_tie_options |
| 24 | virtualResource | Sanal | metadata.liveDetails.virtualResource | `virtual_resource_id` | FK transmission_virtual_resources |

### §5.3 IRD/Fiber slot (event-level — Edit dialog) — 5 alan

| # | Frontend key | Label | Eski yer | Yeni kolon | Tip |
|---|---|---|---|---|---|
| 25 | ird1 (key=ird) | IRD 1 | metadata.liveDetails.ird | `ird1_id` | FK transmission_irds |
| 26 | ird2 | IRD 2 | metadata.liveDetails.ird2 | `ird2_id` | FK transmission_irds |
| 27 | ird3 | IRD 3 | metadata.liveDetails.ird3 | `ird3_id` | FK transmission_irds |
| 28 | fiber1 (key=fiberResource) | Fiber 1 | metadata.liveDetails.fiberResource | `fiber1_id` | FK transmission_fibers |
| 29 | fiber2 (key=fiberResource2) | Fiber 2 | metadata.liveDetails.fiberResource2 | `fiber2_id` | FK transmission_fibers |

### §5.4 Ana Feed / Transmisyon (Teknik Detay grup 2) — prefix'siz, 21 alan

| # | Frontend key | Label | Yeni kolon (live_plan_technical_details) | Tip |
|---|---|---|---|---|
| 30 | feedType | Feed Type | `feed_type_id` | FK transmission_feed_types |
| 31 | satelliteName | Uydu Adı | `satellite_id` | FK transmission_satellites |
| 32 | txp | TXP | `txp` | scalar string |
| 33 | satChannel | Sat Chl | `sat_channel` | scalar string |
| 34 | uplinkFrequency | Uplink Frekansı | `uplink_frequency` | scalar string |
| 35 | uplinkPolarization | Up. Polarizasyon | `uplink_polarization_id` | FK transmission_polarizations |
| 36 | downlinkFrequency | Downlink Frekansı | `downlink_frequency` | scalar string |
| 37 | downlinkPolarization | Dwn. Polarizasyon | `downlink_polarization_id` | FK transmission_polarizations |
| 38 | modulationType | Mod Tipi | `modulation_type_id` | FK transmission_modulation_types |
| 39 | rollOff | Roll Off | `roll_off_id` | FK transmission_roll_offs |
| 40 | videoCoding | Video Coding | `video_coding_id` | FK transmission_video_codings |
| 41 | audioConfig | Audio Config | `audio_config_id` | FK transmission_audio_configs |
| 42 | preMatchKey | Maç Önü Key | `pre_match_key` | scalar string |
| 43 | matchKey | Maç Key | `match_key` | scalar string |
| 44 | postMatchKey | Maç Sonu Key | `post_match_key` | scalar string |
| 45 | isoFeed | Iso Feed | `iso_feed_id` | FK transmission_iso_feed_options |
| 46 | keyType | Key Tipi | `key_type_id` | FK transmission_key_types |
| 47 | symbolRate | Symbol Rate | `symbol_rate` | scalar string |
| 48 | fecRate | Fec Rate | `fec_rate_id` | FK transmission_fec_rates |
| 49 | bandwidth | Bant Genişliği | `bandwidth` | scalar string |
| 50 | uplinkFixedPhone | Sabit Tel 3 (Uplink) | `uplink_fixed_phone` | scalar string |

### §5.5 Yedek Feed (Teknik Detay grup 3) — `backup_*` prefix, 19 alan

| # | Frontend key | Label | Yeni kolon | Tip |
|---|---|---|---|---|
| 51 | backupFeedType | Feed Type Yedek | `backup_feed_type_id` | FK transmission_feed_types |
| 52 | backupSatelliteName | Uydu Adı Yedek | `backup_satellite_id` | FK transmission_satellites |
| 53 | backupTxp | TXP Yedek | `backup_txp` | scalar string |
| 54 | backupSatChannel | Sat Chl Yedek | `backup_sat_channel` | scalar string |
| 55 | backupUplinkFrequency | Uplink Frekansı Yedek | `backup_uplink_frequency` | scalar string |
| 56 | backupUplinkPolarization | Up. Polarizasyon Yedek | `backup_uplink_polarization_id` | FK transmission_polarizations |
| 57 | backupDownlinkFrequency | Downlink Frekansı Yedek | `backup_downlink_frequency` | scalar string |
| 58 | backupDownlinkPolarization | Dwn. Polarizasyon Yedek | `backup_downlink_polarization_id` | FK transmission_polarizations |
| 59 | backupModulationType | Mod Tipi Yedek | `backup_modulation_type_id` | FK transmission_modulation_types |
| 60 | backupRollOff | Roll Off Yedek | `backup_roll_off_id` | FK transmission_roll_offs |
| 61 | backupVideoCoding | Video Coding Yedek | `backup_video_coding_id` | FK transmission_video_codings |
| 62 | backupAudioConfig | Audio Config Yedek | `backup_audio_config_id` | FK transmission_audio_configs |
| 63 | backupPreMatchKey | Maç Önü Key Yedek | `backup_pre_match_key` | scalar string |
| 64 | backupMatchKey | Maç Key Yedek | `backup_match_key` | scalar string |
| 65 | backupPostMatchKey | Maç Sonu Key Yedek | `backup_post_match_key` | scalar string |
| 66 | backupKeyType | Key Tipi Yedek | `backup_key_type_id` | FK transmission_key_types |
| 67 | backupSymbolRate | Symbol Rate Yedek | `backup_symbol_rate` | scalar string |
| 68 | backupFecRate | Fec Rate Yedek | `backup_fec_rate_id` | FK transmission_fec_rates |
| 69 | backupBandwidth | Bant Genişliği Yedek | `backup_bandwidth` | scalar string |

**Not**: Yedek Feed'de `iso_feed_id` ve `uplink_fixed_phone` kolonları YOK (Ana Feed'de var, Yedek için UI'da yoktu — schema'da da yok).

### §5.6 Fiber (Teknik Detay grup 4) — `fiber_*` prefix, 4 alan

| # | Frontend key | Label | Yeni kolon | Tip |
|---|---|---|---|---|
| 70 | fiberCompany | Fiber Firma | `fiber_company_id` | FK technical_companies(FIBER) |
| 71 | fiberAudioFormat | Fiber Audio Format | `fiber_audio_format_id` | **FK fiber_audio_formats** (X1: ayrı tablo) |
| 72 | fiberVideoFormat | Fiber Video Format | `fiber_video_format_id` | **FK fiber_video_formats** (X1: ayrı tablo) |
| 73 | fiberBandwidth | Fiber Bant Genişliği | `fiber_bandwidth` | scalar string |

### §5.7 live_plan_entries kolonları (M5-B1 mevcut)

Aşağıdaki alanlar **`live_plan_entries`** kolonu (M5-B1'de zaten var):

| # | Frontend key | Label | Yeni kolon | Notlar |
|---|---|---|---|---|
| 74 | contentName | Yayın Adı | `live_plan_entries.title` | M5-B1 var |
| 75 | league | Lig | `live_plan_entries.league` (yeni kolon? veya schedule pattern `report_league` scalar) | ⚠ Şu an Schedule'da scalar; live-plan'da yeni kolon eklenir veya report_league pattern korunur. **V1 önerim: scalar `report_league String?` (Schedule pattern)**. Lookup tablosu V2. |
| 76 | notes | Açıklama ve Notlar | `live_plan_entries.operationNotes` | M5-B1 var |

---

## §6 — Lookup management API/UI scope (M5-B5/B6)

### M5-B5 API

```
GET    /api/v1/live-plan/lookups/:type           # list (active only by default)
GET    /api/v1/live-plan/lookups/:type/:id       # detail
POST   /api/v1/live-plan/lookups/:type           # create
PATCH  /api/v1/live-plan/lookups/:type/:id       # update (label, active toggle)
DELETE /api/v1/live-plan/lookups/:type/:id       # soft delete (active=false)
```

`:type` whitelist:
```
satellites, irds, fibers, int_resources, tie_options, demod_options,
virtual_resources, feed_types, modulation_types, video_codings,
audio_configs, key_types, polarizations, fec_rates, roll_offs,
iso_feed_options, equipment_options, companies, locations,
usage_locations, regions, languages, off_tube_options,
fiber_audio_formats, fiber_video_formats
```

Type-specific davranış:
- `equipment_options` ve `companies` için `type` query parametresi (ör. `?type=OB_VAN`).

### M5-B6 UI

Admin sayfası: `/admin/live-plan-lookups`.
- Sol panel: lookup type seçimi (25 tip).
- Sağ panel: seçilen tip için liste + ekle/düzenle/sil.
- Type filter (companies, equipment için).
- Active toggle.

RBAC:
- Read: `livePlan.read`.
- Write: `Admin` veya yeni `livePlan.lookupAdmin` permission (M5-B5 öncesi karar).

---

## §7 — DB CHECK constraint'ler

### live_plan_technical_details

```sql
-- Tek window varsayımı (M5-B7 schema)
ALTER TABLE live_plan_technical_details
  ADD CONSTRAINT live_plan_technical_planned_window_check
  CHECK (planned_end_time IS NULL OR planned_start_time IS NULL
         OR planned_end_time > planned_start_time);
```

### live_plan_transmission_segments

```sql
ALTER TABLE live_plan_transmission_segments
  ADD CONSTRAINT live_plan_transmission_segments_time_check
  CHECK (end_time > start_time);
```

Test interim helper (Madde 4 / PR-A pattern) ile reapply.

---

## §8 — M5 strangler PR sequence cross-ref

Ayrıntılar `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §5 M5-B3..B14:

```
M5-B3  ✅ DECISION K15 + bu doc commit
M5-B4  Lookup tabloları foundation + seed + live_plan_entries.metadata DROP
M5-B5  Lookup management API
M5-B6  Lookup management UI
M5-B7  live_plan_technical_details schema (~80 kolon)
M5-B8  live_plan_transmission_segments schema (entry FK + feed_role enum)
M5-B9  Technical details + segments service/API
M5-B10 Live-plan UI migration
M5-B11 ingest_plan_items.live_plan_entry_id FK (X2)
M5-B12 ingest_plan_items.studio_plan_slot_id FK + XOR CHECK
M5-B13 Cleanup eski metadata + test schedule data
M5-B14 sourceType cleanup (deferred)
```

---

## §9 — Open / V2 scope

V1'de yapılmıyor; V2'ye bırakıldı:

1. **Per-feed transmission tablosu** — eğer Ana/Yedek feed'leri gerçekten farklı uydu/window/IRD kullanıyorsa, `live_plan_technical_details`'in backup_* prefix'li kolonları `live_plan_transmissions` tablosuna split edilebilir (eski K15.2 + W1-W4 yaklaşımı). V1 tek tablo + prefix yeterli kabul edildi.
2. **Lookup management UI'sında bulk seed** — hardcoded frontend listelerden DB'ye toplu seed import'u (M5-B4 migration'ında yapılır; V1'de yeterli).
3. **3+ feed type** (CLEAN/TACTICAL/INTERNATIONAL) — yeni feed türleri gerekirse: ayrı prefix kolonlar (V1 tek tablo şişer) **veya** transmissions tablosu yeniden split (V2 refactor).
4. **`schedule.metadata.liveDetails`** — eski JSON; M5-B13 cleanup'tan sonra hiç yazılmayacak; eski historical data UI'da görünmez (audit log'larda kalır).
5. **Lineage segment ↔ ingest_plan_item** — şu an opsiyonel `ingest_plan_items.live_plan_entry_id` event-level (X2). Segment-level bağlantı V2 lineage scope'unda eklenebilir.

---

## §10 — Risk notu

- M5-B4 deploy edildikten sonra **boş başlayan 12 lookup** UI'da boş dropdown'lar gösterir. Operatör M5-B6 admin UI'sından doldurmadan M5-B7 deploy edilmemeli (UI live-plan ekranı boş select box ile çalışmaz).
- M5-B7 (~80 kolon technical_details migration) büyük bir migration. Test environment'ında schema sync süresini ölç (production migration window planlaması için).
- M5-B13 cleanup öncesi production'da **`schedules.metadata.liveDetails` data örnek incele** — V1 boş başlasa bile production deploy öncesi tekrar SQL çalıştırılması (network onayı ayrı).

---

**Maintainer**: kullanıcı (osmanbaskan / obskan)
**Implementer**: Claude (M5-B4 talep edildiğinde)
