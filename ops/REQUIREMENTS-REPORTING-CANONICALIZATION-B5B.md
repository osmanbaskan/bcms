# Reporting Canonicalization — SCHED-B5b (preflight + karar)

> **Status**: 📋 Karar dokümanı (implementation BLOCKED — UI freeze).
> **Tarih**: 2026-05-11
> **Bağlam**: SCHED-B5a Block 2 apply edildi (`52db5a9`, 2026-05-10); `schedules.usage_scope` ve `schedules.deleted_at` DROP. Geriye `schedules.metadata` + `schedules.start_time` + `schedules.end_time` legacy kolonları kaldı; bunlar `/schedules/reporting` UI'sının halen tek beslenme kaynağı.

---

## §1 — Current state

### §1.1 DB

`schedules` tablosunda kalan legacy kolonlar:

| Kolon | Tip | Canonical karşılık | Reporting bağımlılığı |
|-------|-----|---------------------|-----------------------|
| `metadata` | `Json?` | (yok) | `metadata.contentName`, `metadata.houseNumber` reporting tablosunda fallback olarak kullanılır |
| `start_time` | `Timestamptz` | `schedule_date + schedule_time` (Türkiye-naive compose) | Reporting tablosu Saat sütunu (`time24(row.schedule.startTime)`) |
| `end_time` | `Timestamptz` | (canonical karşılık YOK) | Reporting tablosu Bitiş sütunu + duration (`(endTime - startTime) / 60000`) |
| `channel_id` | `Int?` | Y5-8'de DROP edildi | Reporting `schedule.channel?.name ?? '-'` (deprecated alan; her zaman `'-'`) |

Schedule canonical `create/update` placeholder yazımı (`schedule.service.ts:238-239, 297-298`):
```
startTime = scheduleDate + scheduleTime as UTC suffix (naive)
endTime   = startTime + 2h sabit placeholder
```

⚠ Bu pattern **gerçek instant değil** — naive UTC suffix. Reporting `datePipe.transform(value, 'HH:mm', '+0300')` ekleyerek render eder → UI'da **3 saat ileri görünür**. Mevcut bug, B5a'dan beri var.

### §1.2 Reporting UI

`apps/web/src/app/features/schedules/reporting/schedule-reporting.component.ts`:
- Kolonlar: `startTime`, `endTime`, `channel`, `title`, `houseNumber`, `duration`
- Yayın label: `metadata.contentName || schedule.title` (BXF legacy)
- House No: `metadata.houseNumber || '-'` (BXF legacy)
- Kanal: `schedule.channel?.name ?? '-'` (Y5-8 sonrası her zaman '-')
- Süre: `endTime - startTime` (sabit 2h placeholder)
- Time render: `+0300` offset, `datePipe HH:mm`
- Day range: `T00:00:00${env.utcOffset}` … `T23:59:59${env.utcOffset}`

### §1.3 Backend reporting endpoint'leri

`apps/api/src/modules/schedules/schedule.routes.ts`:
- `GET /reports/live-plan/filters` (league/season/week — `reportLeague`/`reportSeason`/`reportWeekNumber` kolonlarından beslenir; B5b dışında)
- `GET /reports/live-plan` (data — `findAll` üzerinden; `metadata`/`start_time`/`end_time` döner)
- `GET /reports/live-plan/export` (Excel — `schedule.export.ts` üzerinden)

`schedule.export.ts` "TARİH / SAAT / MAÇ / KANAL" Excel kolonu üretir.

### §1.4 Aktif veri durumu

B5a Block 2 sonrası `schedules` tablosunda 1 row kaldı (canonical broadcast flow; `event_key NOT NULL`). Bu satırda `metadata = NULL`, `startTime/endTime = placeholder`. Reporting tablosu pratikte boş fallback gösterir (`title || '-'`, `'-'`, `'-'`, `120 dk` sabit).

132 legacy BXF satırı DELETE edildi (`event_key IS NULL` filter). Eski operasyonel reporting "canlı yayın planı" tablosu bu satırlardan beslenirdi; artık veri yok.

---

## §2 — Why blocked by UI freeze

Reporting kanonikleştirme zorunlu UI değişiklikleri içerir:

- **Saat render**: `+0300` offset literal helper'a taşınmalı (`formatIstanbulTime`) — bu **template değişikliği**.
- **House No kolonu**: kanonik kaynak yok (BXF kapandı). Ya kolon çıkarılır (UI değişikliği) ya structured kolon eklenir (B5b backend + UI değişikliği).
- **Yayın label**: `metadata.contentName` fallback'i ya kanonik kolon (B5b backend + UI) ya schedule.title only (UI değişikliği).
- **Süre kolonu**: 120dk sabit placeholder yerine kanonik bilgi yok. Ya gerçek duration alanı (B5b backend + UI) ya kolon kaldır (UI).
- **Kanal kolonu**: Y5-8 sonrası `schedule.channel?.name` `?? '-'` ile her zaman boş. Kolon kaldır veya 3-slot canonical join eklenir (UI ya da backend response shape değişikliği).
- **Datasource compose**: `env.utcOffset` `T...23:59:59` → `istanbulDayRangeUtc(date)` helper'a taşı (template / load() değişikliği).

Kullanıcının açık talimatı:
- "UI freeze devam ediyor."
- "schedule-reporting.component.ts dosyasına dokunma."
- "Sahte default duration veya placeholder canonical alan yazılmayacak."
- "contentName/houseNumber için yeni kolon açılmayacak; BXF kaynaklı legacy alanlar."

Bu kısıtlar reporting'i bir bütün olarak yeniden tasarlamayı zorunlu kılar; küçük dokunma ile çözülmez.

---

## §3 — Reporting TZ drift detayı

`schedule.service.ts` create/update placeholder pattern:
```
const startISO = `${dto.scheduleDate}T${normalizeTime(dto.scheduleTime)}.000Z`;
data.startTime = new Date(startISO);   // → DB'de UTC olarak "Türkiye saati"
data.endTime   = new Date(startDate.getTime() + 2 * 3600 * 1000); // +2h
```

Reporting tarafında render:
```
this.datePipe.transform(value, 'HH:mm', '+0300')
```

Sonuç (operatör Türkiye 19:00 yayın oluşturursa):
- DB: `startTime = 2026-06-01T19:00:00.000Z` (UTC olarak okunur; gerçek instant Türkiye 22:00)
- UI: `time24` `+0300` ekler → `2026-06-01T22:00:00+03:00` → **22:00 görünür** (yanlış)

Düzeltme yolları (her biri yine UI değişikliği):
- **(α)** `schedule.service.ts` compose'u `composeIstanbulInstant`'a çevir → DB'ye gerçek UTC instant (Türkiye 19:00 → UTC 16:00) → `formatIstanbulTime` render Türkiye 19:00. Ama 3 integration spec `startTime.toISOString() === naive UTC suffix` bekliyor; spec güncelleme + B5b ile birlikte yapılır.
- **(β)** Reporting render'ını naive UTC okuma yap (`getUTC*` veya `+0000`) → mevcut placeholder pattern'le uyumlu, **3 saat drift düzelir** ama `formatIstanbulTime` helper semantik'i ile çelişir (helper UTC instant'ı Türkiye TZ'ye çevirir; naive okuma için farklı helper gerek).

Her iki yol UI'ya dokunmayı gerektiriyor → BLOCKED.

---

## §4 — Required UI approval points

B5b implementation için kullanıcı onayı gerekli kararlar:

1. **`houseNumber` kolonu reporting tablosundan kaldırılsın mı?** (BXF kapandı, kanonik kaynak yok)
2. **`metadata.contentName` fallback kaldırılsın, sadece `schedule.title` gösterilsin mi?**
3. **`channel` kolonu reporting tablosundan kaldırılsın mı?** (Y5-8 sonrası her zaman '-')
4. **`duration` kolonu kaldırılsın mı?** (120dk sabit placeholder; gerçek duration alanı yok)
5. **`startTime/endTime` kolonları kanonik `scheduleDate + scheduleTime` ile değiştirilsin mi?** (saat → `scheduleTime` HH:MM)
6. **Excel export kolon başlıkları aynı kalır mı?** (TARİH / SAAT / MAÇ / KANAL → KANAL boş kalırsa rahatsız mı?)
7. **`/reports/live-plan/filters` endpoint'i korunsun mu?** (league/season/week filter zaten `reportLeague/Season/WeekNumber` kanonik kolonlardan beslenir; bu doğru çalışır)

---

## §5 — Options

### Option A — Reporting kolonlarını sadeleştir (UI APPROVAL gerekli)

**Kapsam**:
- `houseNumber`, `contentName`, `channel`, `duration` kolonlarını UI tablosundan **kaldır**
- Saat render canonical `scheduleTime` üzerinden (`HH:MM` direct)
- Day range `istanbulDayRangeUtc` helper
- Excel export'tan KANAL kolonu kaldır

**Backend değişikliği**:
- `schedule.routes.ts` `/reports/live-plan` response shape: sadece canonical alanlar
- `schedule.service.ts` placeholder `startTime/endTime` yazımı **kalır** (B5b bu turun sonunda; sahte placeholder kabul edilmediği için zorunlu DROP olur)
- B5b drop migration: `metadata`, `start_time`, `end_time` DROP

**Pros**: Sade UI; sahte default yok; UI freeze açıldığında küçük scope refactor.

**Cons**: Reporting bilgi değeri düşer (operatör pratikte zaten boş tablo görüyor).

### Option B — Real duration alanı ekle (B5b backend + UI APPROVAL)

**Kapsam**:
- `schedules.event_duration_min INT NOT NULL` kolonu ekle (yeni canonical)
- Operatör broadcast flow create body'sinde `eventDurationMin` zorunlu (ya da live-plan entry duration'dan otomatik)
- Reporting `duration` kolonu canonical alandan beslenir
- Diğer Option A değişiklikleri

⚠ **Kullanıcı talimatı**: "sahte default canonical kabul edilmedi" → 120 dk default eklenirse karşı. Default null veya zorunlu input olmalı; null ise reporting "—" gösterir.

**Pros**: Gerçek duration bilgisi reporting'de görünür.

**Cons**: Broadcast flow create body genişler (UI form değişikliği); LivePlanEntry duration'a alternatif (çift kayıt).

### Option C — `start_time/end_time` retain, sadece TZ drift fix

**Kapsam**:
- Reporting render'ı `+0300` yerine `formatIstanbulTime` veya naive okuma → drift düzelir
- `schedule.service.ts` placeholder compose'u `composeIstanbulInstant`'a çevir → DB gerçek instant
- 3 integration spec güncelle (`startTime.toISOString()` beklentileri canonical UTC'ye)
- B5b drop migration yapılmaz; metadata/start_time/end_time kalır

⚠ **Kullanıcı talimatı**: "sahte canonical veri istemiyoruz" → placeholder davranış kalır. Bu Option B5b'nin asıl amacını taşımaz.

**Pros**: Minimal değişiklik; TZ drift düzelir.

**Cons**: Schema temizliği yapılmaz; legacy kolonlar duruyor; placeholder hâlâ var.

---

## §6 — Recommended future path

**Option A** önerilen yol. Sebep:
- Kullanıcının açık tercihi: "sahte canonical default kabul edilmedi"
- BXF kapandı → metadata.contentName/houseNumber tarihsel artefakt; UI'da gösterip kanonik almayan kolon kafa karıştırıcı
- Y5-8 sonrası channel hep '-' → kolon var olduğu için operatör "neden kanal yok" düşünür
- Süre 120dk sabit → operasyonel olarak yanıltıcı

**Sıralama**:
1. UI freeze açılana kadar BLOCKED.
2. UI APPROVAL alınınca: Option A reporting UI sadeleşmesi + B5b drop migration birlikte.
3. Operasyonel ihtiyaç doğarsa duration için ayrı tur (Option B varyantı; ama broadcast create body değişikliği gerek).

---

## §7 — Migration outline (no file yet)

Bu doc onay aldığında oluşturulacak migration:

```
-- B5b destructive cleanup (apply ayrı faz; backup zorunlu)
ALTER TABLE schedules
  DROP COLUMN IF EXISTS metadata,
  DROP COLUMN IF EXISTS start_time,
  DROP COLUMN IF EXISTS end_time;
```

Pre-flight (apply öncesi):
- Backend `schedule.service.ts` placeholder compose kaldır
- Backend `schedule.export.ts` startTime referansları → scheduleDate + scheduleTime
- Backend `schedule.routes.ts` `/reports/live-plan*` response shape canonical
- Frontend reporting UI Option A sadeleşmesi
- 3 integration spec güncelle (placeholder beklentilerini kanonik scheduleTime'a)

Apply sonrası:
- `prisma migrate deploy`
- `docker compose up -d --build api worker web`
- Reporting smoke
- Push

---

## §8 — Test plan (B5b implementation tetiklendiğinde)

| Test | Beklenti |
|------|----------|
| `prisma migrate status` | Yeni B5b migration pending |
| `npm run build -w packages/shared / api / web` | EXIT=0 |
| `npm run test:unit -w apps/api` | tz helpers + diğer 18/18 |
| `npm run test:integration -w apps/api` | schedule.broadcast-flow placeholder testleri DROP; live-plan-sched-sync canonical kalır |
| Karma reporting spec | yeni canonical sütun beklentileriyle güncel |
| Smoke `/health` | 200 |
| `/reports/live-plan` 200 + canonical shape | döner |
| `/reports/live-plan/export` xlsx döner; KANAL kolonu boş veya kaldırılmış |

---

## §9 — Açık sorular

1. **Reporting bilgi değeri**: Mevcut reporting tablosu canlı veride pratikte boş. Operatörler bu reporting'i kullanıyor mu, kullanmıyorsa B5b kapsamı "UI sadeleşmesi" yerine "endpoint deprecation" mı olmalı?
2. **`reportLeague/Season/WeekNumber`**: Bu kolonlar canonical alan; filter endpoint'i çalışıyor. B5b kapsamında **kalmalı** (lig/sezon/hafta filtreleri operasyonel olarak değerli).
3. **Excel export**: Hala yararlı mı, yoksa OPTA fixture list export'una mı yönlendirilmeli?
4. **Saat semantiği**: Reporting "yayın başlangıç saati" mi gösterir, "yayın penceresi başlangıcı" mı? Kanonik model bu ayrımı netleştirmiyor.

---

## §10 — Review history

| Tarih | Yorum |
|-------|-------|
| 2026-05-11 | İlk B5b karar dokümanı. UI freeze altında BLOCKED. Option A önerilen yol. Implementation kullanıcı UI APPROVAL'ı sonrasında. |
