# Provys BXF — Title Field Tasarım Notları

> **Durum:** tasarım notu / karar kaydı. Bu doküman **kod değişikliği veya DB migration tetiklemez**. Aşağıda listelenen aday alanlar ileride değerlendirilebilir; herhangi biri uygulanmadan önce **ayrı onay** istenmelidir.

Tarih: 2026-05-25

## Karar özeti

1. **`provys_items.title` şu an türetilmiş display alanıdır.** Parser BXF'ten 6 farklı kaynağı sıralı önceliklendiriyor; ilk dolu olan kazanıyor. UI bu derived değeri gösterir.
2. **Şu anda DB schema değişmeyecek.** Yeni kolon eklenmeyecek, Prisma migration üretilmeyecek.
3. Bu doküman, ileride "açıklayıcı görünüm" iyileştirilmek istendiğinde tasarımın hangi ham BXF kaynaklarına dayanacağını net göstermek için tutulur.

## `title` türetme öncelik zinciri (mevcut parser davranışı)

`apps/api/src/modules/provys/provys.parser.ts` — `deriveTitle(scheduledEvent, evd)` fonksiyonu.

İlk dolu kaynak kazanır, max 500 char, trim:

| # | Öncelik | BXF XML path | Açıklama |
|---|---------|--------------|----------|
| 1 | **VersionName** | `Content/Description[@type="VersionName"]` | En zengin metin — maçta takım çifti, programda bölüm konusu |
| 2 | **EpisodeName** | `Content/ContentDetail/ProgramContent/Series/EpisodeName` | Bölüm başlığı (genelde VersionName ile özdeş) |
| 3 | **EventTitle** | `EventData/EventTitle` | Generic program/seri başlığı |
| 4 | **Content.Name** | `ScheduledEvent/Content/Name` | Kısa içerik adı |
| 5 | **ProgramName** | `EventData/PrimaryEvent/ProgramEvent/ProgramName` | Program adı |
| 6 | **AdType / SpotType** | `EventData/PrimaryEvent/NonProgramEvent/Details/AdType` (+ `SpotType`) | Promo/Reklam fallback etiketi (örn. "Promo / Standard") |

## Şu anki kayıt durumu

| Kolon | Kaynak | Doluluk |
|-------|--------|---------|
| `title` | yukarıdaki zincir (derived) | %100 (parser her zaman üretir) |
| `dc_code` | `Content/ContentId/HouseNumber` (fallback: `ContentMetaData/...`) | %84.6 (REKLAM kategorisi %0 — Provys exporter göndermiyor) |
| `raw_kind` | sinyal derivation (Live/PSA/Commercial/ProgramHeader/AdType/Program/eventType) | %100 |
| `category` | classifier(rawKind) | %100 |
| `user_note` | UI PATCH /provys/items/:id/note | nadir (manuel) |

Ham kaynak alanlar **şu an kaydedilmiyor**; sadece derived `title` ve `dc_code` saklanır.

## İleride değerlendirilecek aday alanlar (henüz uygulanmadı)

Aşağıdaki kolonlar açıklayıcı görünüm geliştirilmek istendiğinde **ayrı bir onayla** eklenebilir. Sadece tasarım önerisidir.

### Ham title kaynakları

| Aday kolon | Tip | BXF kaynağı | Beklenen doluluk |
|------------|-----|-------------|------------------|
| `version_name` | `varchar(500)` nullable | `Content/Description[@type="VersionName"]` | Çoğu içerikte dolu |
| `episode_name` | `varchar(500)` nullable | `Series/EpisodeName` | Sadece ProgramEvent (Maç/Program); NonProgramEvent'te null |
| `event_title` | `varchar(500)` nullable | `EventData/EventTitle` | Çoğu içerikte dolu, çoğu zaman SeriesName/Content.Name ile özdeş |
| `content_name` | `varchar(500)` nullable | `Content/Name` | Çoğu içerikte dolu |
| `program_name` | `varchar(500)` nullable | `ProgramEvent/ProgramName` | Sadece ProgramEvent; NonProgramEvent'te null |
| `ad_type` | `varchar(40)` nullable | `NonProgramEvent/Details/AdType` | Sadece NonProgramEvent (Tanıtım/Kamu Spotu/Reklam) |
| `spot_type` | `varchar(40)` nullable | `NonProgramEvent/Details/SpotType` | NonProgramEvent altında, çoğunlukla "Standard" |
| `title_source` | `varchar(40)` nullable | enum (parser'ın kararı) | `VERSION_NAME` / `EPISODE_NAME` / `EVENT_TITLE` / `CONTENT_NAME` / `PROGRAM_NAME` / `AD_TYPE_SPOT_TYPE` — derived `title` hangi kaynaktan seçildi |

### Series metadata (önceki tasarım notundan)

| Aday kolon | Tip | BXF kaynağı | Beklenen doluluk |
|------------|-----|-------------|------------------|
| `series_name` | `varchar(300)` nullable | `Series/SeriesName` | Sadece ProgramEvent — UI üst başlık (program ailesi/turnuva adı) |
| `episode_number` | `smallint` nullable | `Series/EpisodeNumber` | Sadece ProgramEvent — UI metadata (Bölüm sıra no) |

## Maliyet / risk değerlendirmesi (uygulanırsa)

- **Migration:** tek `ALTER TABLE provys_items ADD COLUMN ...` ile 10 nullable kolon. Mevcut 37k satıra dokunmaz.
- **Parser değişikliği:** ~20-30 satır — `ParsedItem` interface'e alan eklemek + `parseBxf` içinde Series + Description + AdType objelerinden alan çıkartmak.
- **Watcher / applyDiff:** `payloadHash` canonical payload'a yeni alanları dahil etmeli (aksi takdirde diff onları görmez, update tetiklenmez). `provys.service.ts` içinde canonical hash logic.
- **Backfill durumu:** Migration sonrası **mevcut 37k satır null kalır**. Backfill için iki yol:
  1. Watcher'ı yeniden başlat + tüm BXF dosyalarına `touch` (mtime değişir, snapshot yeniden okunur, applyDiff diffini görür ve update tetikler). Yan etki yok, audit log dolar.
  2. Tek seferlik script (worker container içinde): `prisma.provysItem.findMany` + dosyayı yeniden parse + targeted update. Daha kontrollü ama ek kod gerektirir.
  Backfill her durumda **ayrı onay** ister.
- **UI değişikliği:** Mevcut tek-`title` görünümü ileride iki seviyeliye geçerse (`series_name` üst başlık + `title` alt başlık), template seviyesinde minimal. NonProgramEvent için `series_name` null → fallback tek seviyeli (eski görünüm bozulmaz).

## Onay gerektiren işler

Aşağıdaki adımların **hiçbiri bu doküman tarafından tetiklenmiyor** — her biri için ayrı onay alınmalı:

1. Prisma schema'ya yeni kolon ekleme
2. Migration üretme (`prisma migrate dev` veya manuel SQL)
3. Parser'ı yeni alanları yazacak şekilde değiştirme
4. `payloadHash` canonical input'unu genişletme
5. API response'a yeni alanları ekleme
6. UI'da yeni alanları kullanma
7. Mevcut 37k satır için backfill çalıştırma

## Referans

- **Analiz Excel matrisi (4 materyal tipi × ~30 BXF alanı):** `/home/ubuntu/Desktop/provys-bxf-field-matrix.xlsx` (sheet'ler: Summary, Matrix, DB Rows, Recommendations)
- **Parser kodu:** `apps/api/src/modules/provys/provys.parser.ts` (`deriveTitle`, `extractDcCode`, `deriveRawKind`)
- **Classifier kodu:** `apps/api/src/modules/provys/provys.classifier.ts` (rawKind → category)
- **Service / applyDiff:** `apps/api/src/modules/provys/provys.service.ts` (canonical hash, transaction, pg_notify)
- **Schema:** `apps/api/prisma/schema.prisma` — `ProvysItem` model
- **REKLAM caveat:** Provys exporter `Commercial` event'lerine DC kodu + zenginleştirilmiş title vermiyor (sadece "REK 1", "REK 6" gibi). BCMS parser tarafında çözülemez — Provys-side fix gerektirir.

## Bu doküman ne yapar / yapmaz

✅ **Yapar:** Title derivation mantığını kayıt altına alır, ileride hangi BXF alanlarının ayrı saklanabileceğine dair tasarım önerisini açıkça listeler, Excel matris ve parser kod konumlarını gösterir.

❌ **Yapmaz:** DB schema'sını değiştirmez, migration üretmez, parser/service/API/UI kodunu değiştirmez, backfill çalıştırmaz. Hiçbir Prisma model ya da yeni kolon `provys_items`'a eklenmedi.
