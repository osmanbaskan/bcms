# Status Model Rethink — V1 (preflight)

> **Status**: 📋 Karar dokümanı (implementation yok). Bağlam: MCR sekmesi ve `/playout/*` endpoint'leri kaldırıldı (`0e10e62`, 2026-05-10). Şu an `ScheduleStatus.ON_AIR`'a geçişi tetikleyen runtime mekanizması yok.
>
> **Tarih**: 2026-05-11
> **Cross-reference**: `ops/REQUIREMENTS-SCHEDULE-BROADCAST-FLOW-V1.md`, `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md`, `ops/REQUIREMENTS-SCHEDULE-OPTA-SYNC-V1.md` (KO14).

---

## §1 — Mevcut durum envanteri (kanıt)

### §1.1 Schedule status enum

`packages/shared/src/types/schedule.ts:1`:
```
ScheduleStatus = 'DRAFT' | 'CONFIRMED' | 'ON_AIR' | 'COMPLETED' | 'CANCELLED'
```

DB enum aynı (`apps/api/prisma/schema.prisma:678`).

### §1.2 LivePlanEntry status enum

`apps/api/prisma/schema.prisma:691`:
```
LivePlanStatus = PLANNED | READY | IN_PROGRESS | COMPLETED | CANCELLED
```

İki ayrı durum modeli var; Schedule ve LivePlanEntry farklı transition aşamaları temsil ediyor (Schedule yayın akışı, LivePlanEntry event canlı/operasyonel durumu).

### §1.3 ON_AIR'a yazan kim?

**Hiç kimse** (post-MCR removal).

| Eski yazıcı | Durum |
|-------------|-------|
| `/playout/:id/go-live` → `data: { status: 'ON_AIR' }` | **SİLİNDİ** (MCR removal commit `0e10e62`) |
| MCR UI `mcr-panel.component.ts:goLive()` → POST `/playout/:id/go-live` | **SİLİNDİ** |
| OPTA cascade veya başka backend yolu | Yok (cascade ON_AIR'i frozen sayar; yazmaz) |

Sonuç: bir schedule `ON_AIR` durumuna geçirilemez. Yeni schedule oluşturulduğunda default `DRAFT`; sonra UI üzerinden `CONFIRMED`'a çekilebilir (canonical broadcast flow `PATCH /broadcast/:id`). `COMPLETED` ve `CANCELLED` schedule UI'sından yazılabilir.

### §1.4 ON_AIR'ı okuyup davranış değiştiren kim?

| Yer | Davranış |
|-----|----------|
| `apps/api/src/modules/opta/opta-cascade.service.ts:38` | `FROZEN_SCHEDULE_STATUSES = ['COMPLETED', 'CANCELLED', 'ON_AIR']` — OPTA cascade ON_AIR'daki schedule'ları update etmez (KO14 lock) |
| `apps/web/src/app/features/dashboard/dashboard.component.ts:487` | "Şu an yayın" hero card seçimi: `b.status === 'ON_AIR'` |
| `apps/web/src/app/features/dashboard/dashboard.component.ts:493` | Canlı yayın sayacı: `ON_AIR \|\| CONFIRMED` |
| `apps/web/src/app/features/yayin-planlama/yayin-planlama-list.component.ts:86` | Status filter dropdown opsiyonu `<mat-option value="ON_AIR">Yayında</mat-option>` |
| `apps/web/src/app/core/services/schedule.service.ts:39` | `mapLivePlanEntryToSchedule` status mapping: `IN_PROGRESS` (LivePlanEntry) → `ON_AIR` (Schedule). Yani live-plan tarafı `IN_PROGRESS` yapılırsa schedule UI projeksiyonu `ON_AIR` görünür. |
| `apps/web/src/app/core/ui/status-tag.component.ts:23` | "YAYINDA" rozet (kırmızı) |
| `apps/web/src/styles/tokens.scss:130-131, 176-177` | ON_AIR theme renkleri |
| `apps/web/src/styles.scss:89` | ON_AIR badge css class |
| Integration test mock'lar | `opta-sync-cascade.integration.spec.ts:402` `makeOptaSchedule({ status: 'ON_AIR' })` — frozen-status davranışı testi |

### §1.5 LivePlanEntry IN_PROGRESS yazıcı

`LivePlanService.update` PATCH'i her statüye geçişi destekler (mevcut M5-B2 API). UI dialog (Yayın Planlama) operatörün el ile `IN_PROGRESS`'e çekebilmesini sağlıyor olabilir; LivePlanEntry edit-dialog kontrol etmek gerekir (preflight kapsamı dışı).

LivePlanEntry status'i `IN_PROGRESS` yapılırsa frontend mapper `mapLivePlanEntryToSchedule` Schedule projeksiyonunu `ON_AIR` olarak gösterir → dashboard "yayın" sayacı ve hero card etkili olur. Yani **dolaylı olarak LivePlanEntry IN_PROGRESS = UI'da ON_AIR projeksiyonu**.

Ama bu projeksiyon sadece **UI tarafı**. Schedule DB row'unun `status` kolonu `ON_AIR` olmaz; mapping frontend'de yapılır. OPTA cascade DB'deki schedule status'una bakar → cascade frozen-check `ON_AIR` schedule'ları durdurmaz çünkü DB'de yok.

**Çıkarım**: Şu an `ON_AIR` semantik olarak **iki tanımdan birine** bağlı:
- (a) **DB schedule.status = 'ON_AIR'**: hiç set edilmiyor; OPTA cascade frozen-check pratikte etkisiz.
- (b) **LivePlanEntry.status = 'IN_PROGRESS' → frontend Schedule.status = 'ON_AIR' projeksiyon**: dashboard sayacı + status badge için tek geçerli yol.

---

## §2 — MCR sonrası ON_AIR gerçekten gerekli mi?

### §2.1 Yayın operasyonu için

- **Schedule.status = ON_AIR**: gerçek yayın anının DB-kayıtlı durumu. Operatör veya otomatik mekanizma ile set edilirdi. Şimdi yok.
- Kullanım: opta cascade frozen-check, dashboard sayacı, status badge.

### §2.2 LivePlanEntry IN_PROGRESS için

- Live-plan operatör (Tekyon/Transmisyon) tarafından canlı yayın anında elle `IN_PROGRESS`'e çekilebilir.
- Bu durumun frontend mapping üzerinden Schedule projeksiyonu `ON_AIR` olur — dashboard "yayın" göstergesi çalışır.
- OPTA cascade DB Schedule.status'a bakar — cascade frozen-check IN_PROGRESS bilgisini görmez. **Buradan operasyonel risk**: live-plan IN_PROGRESS olan event hâlâ OPTA cascade ile çakışabilir.

### §2.3 Sonuç

ON_AIR durumu **iki ayrı yere parçalanmış**:
- Backend semantik (Schedule.status): kayıt amaçlı, ama setter yok.
- Frontend semantik (LivePlanEntry projeksiyon): operasyonel canlı gösterim, ama DB-side bir cascade frozen-check yapamaz.

Bu **tutarsız**; rethink kaçınılmaz.

---

## §3 — Alternatifler

### Alternatif A — ON_AIR enum kalır + manuel admin endpoint eklenir

**Tasarım**:
- Yeni endpoint: `POST /api/v1/schedules/broadcast/:id/go-live` ve `POST /api/v1/schedules/broadcast/:id/end`
- Body: opsiyonel `note`, `tc` (timecode); audit log için
- Business rule: status `CONFIRMED → ON_AIR`, `ON_AIR → COMPLETED`
- 3-channel slot conflict matrix: aynı slot'lardan birinde başka schedule ON_AIR ise 409 (eski playout pattern, canonical model'e taşınmış)
- RBAC: `PERMISSIONS.schedules.write` veya yeni `PERMISSIONS.schedules.broadcast` namespace

**Pros**:
- Schedule.status DB'de canlı durum tutar — OPTA cascade frozen-check anlamlı hale gelir
- Manuel operatör kontrolü; otomatik scheduler yok
- Eski playout business logic'inin temiz canonical reimplementation'ı

**Cons**:
- MCR UI'sı kaldırıldı; bu endpoint'leri kim çağıracak? Mevcut UI'lerden hangisi go-live butonu içerecek?
- Yeni UI gerekirse UI freeze altında BLOCKED
- LivePlanEntry IN_PROGRESS ile çift kayıt riski (operatör hangi yerden status değiştirmeli?)

**Risk**: UI tasarımı netleşmeden backend yapılırsa unused endpoint.

### Alternatif B — ON_AIR otomatik scheduleTime'a göre türetilir

**Tasarım**:
- Schedule.status DB'de tutulmaz; status computed:
  - `scheduleTime ≤ now < scheduleTime + duration` → ON_AIR
  - `now > scheduleTime + duration` → COMPLETED
  - `now < scheduleTime` → CONFIRMED (DB değerinde DRAFT ise DRAFT)
- API response'ta `status: 'ON_AIR'` server-side compute edilir
- OPTA cascade frozen-check de compute pattern'i kullanır

**Pros**:
- Manuel operatör müdahalesi gerekmez
- Eski "go-live" butonu ihtiyacı yok
- LivePlanEntry IN_PROGRESS ile tutarlı (zaman bazlı; ikinci kayıt yok)

**Cons**:
- Yayın gerçekten zamanında başlamayabilir (donanım, hava durumu, vb. gecikme) — DB'de gerçek başlangıç zamanı tutulmaz
- Operatör "yayın iptal" yapması gerekirse status nasıl override edilir? CANCELLED enum lazım
- `event_duration_min` kolonu eklenmeli (B5b kapsamı + `şahte canonical default kabul edilmedi`)
- Reporting'in canonical duration'a bağımlılığı (B5b ile uyumsuz)
- Time-based compute → reporting export anında server clock'a bağlı (idempotent değil)

**Risk**: B5b ile çift bağımlılık + sahte default sorunu.

### Alternatif C — Schedule.ON_AIR kaldırılır, sadece LivePlanEntry.IN_PROGRESS kalır

**Tasarım**:
- `ScheduleStatus` enum'dan `ON_AIR` çıkarılır → `DRAFT | CONFIRMED | COMPLETED | CANCELLED`
- Canlı yayın "now playing" semantik LivePlanEntry.status = `IN_PROGRESS` ile temsil edilir
- Frontend mapper artık `IN_PROGRESS → ON_AIR` çevirisi yapmaz; Schedule shape'i direkt LivePlanEntry status'unu yansıtır veya ayrı `currentlyOnAir: boolean` computed field
- OPTA cascade frozen-check: `FROZEN_SCHEDULE_STATUSES` listesinden ON_AIR çıkar; cascade live-plan IN_PROGRESS satırlarını ayrı sorguyla filtreler

**Pros**:
- "İki domain, iki status enum" çelişkisi yok
- LivePlanEntry zaten canlı operasyonun source-of-truth'u (operatör tarafı)
- Schedule basit yayın akışı kayıt tablosu kalır
- ON_AIR'a kim yazıyor sorusu ortadan kalkar

**Cons**:
- DB migration: `ScheduleStatus` enum'dan ON_AIR çıkarılır → DB'de ON_AIR satır varsa migrate gerekir (şu an DB'de muhtemelen 0)
- Frontend dashboard, status-tag, theme tokens, schedule-list-mapper güncellenir → **UI değişikliği**
- OPTA cascade refactor (frozen-check now cross-domain JOIN)
- Status mapping davranış değişikliği reporting'i etkiler (B5b uyumlu olur ama B5b BLOCKED)

**Risk**: UI freeze altında BLOCKED.

### Alternatif D — Status model sadeleşir (Schedule.status kaldırılır)

**Tasarım**:
- `Schedule.status` enum tamamen kaldırılır. Schedule kayıt = "yayın akışı entry'si"; çalışıyor/çalışmıyor LivePlanEntry'den okunur.
- Schedule'da sadece **lifecycle** alanı kalır (örn. `cancelledAt: TIMESTAMPTZ?`) veya iptal LivePlanEntry üzerinde
- DB Schedule.status enum + kolon DROP
- OPTA cascade frozen-check sadece LivePlanEntry tabanlı

**Pros**:
- Çift status enum karmaşası çözülür
- Schedule basit relational tablo (event_key + 3 channel slot + canonical alanlar)
- LivePlanEntry hem canlı durum hem iptal durum

**Cons**:
- Büyük refactor: dashboard, status-tag, theme, schedule-list, yayin-planlama list filter, reporting hepsi etkilenir → **UI değişikliği**
- Backend `cancelledAt` veya benzeri yeni alan eklenir
- Status filter UI'sı tamamen kaybolur veya LivePlanEntry status'a aktarılır
- DB migration zor: mevcut status değerleri silinir

**Risk**: En büyük UI/refactor scope; UI freeze altında BLOCKED.

---

## §4 — Önerilen yön

Bu doc karar **vermek** için değil **alternatifleri ortaya koymak** için. Kullanıcı kararı bekleniyor.

Yine de pragmatik öneri sırası:

1. **Kısa vadeli (UI freeze altında)**:
   - **Alternatif C'nin bir alt-varyantı**: OPTA cascade FROZEN_SCHEDULE_STATUSES'tan `'ON_AIR'`'ı çıkar (zaten yazılmıyor; etkisiz filter). Bu tek satır backend değişikliği, davranış aynı (kimse ON_AIR yazmıyor).
   - Frontend dashboard `b.status === 'ON_AIR'` ifadelerini koru (zaten hiç match etmiyor — boş hero card + 0 sayacı; mevcut zaten regress).
   - **Kullanıcı kararı**: kısa vadeli durum yeterli mi? Yoksa A/B/C/D arasında seçim?

2. **Orta vadeli (UI freeze açıldığında)**:
   - **Alternatif C**: en temiz domain ayrımı + en az UI scope (dashboard + status-tag adapter güncellemesi). LivePlanEntry IN_PROGRESS source-of-truth.
   - Manuel go-live admin endpoint istenirse: Alternatif A ile birleştirilebilir (Yayın Planlama UI üstünde inline buton).

3. **Uzun vadeli (B5b ile birlikte)**:
   - Schedule.status DB-level DROP (Alternatif D) çok kapsamlı; B5b sonrasında değerlendirilir.

---

## §5 — Açık sorular

1. **Operasyonel ihtiyaç**: Operatör MCR olmadan canlı yayını nereden takip edecek?
   - Dashboard yeterli mi? Dashboard şu an LivePlanEntry IN_PROGRESS projeksiyonuyla beslenir; ama operatör IN_PROGRESS'e nereden çekiyor?
   - Yayın Planlama list'inde "Yayında" filter var; ama dashboardun "şu an yayın" göstergesi pratikte 0 mı?

2. **OPTA cascade**: Cascade ON_AIR'i frozen sayıyor. Bu kuralı koruyalım mı?
   - Eğer ON_AIR set eden yok ise kuralı silmek güvenli (Alternatif C). 
   - Eğer Alternatif A ile manuel set edilecekse kural anlamlı.

3. **Status filter (Yayın Planlama list)**: `<mat-option value="ON_AIR">Yayında</mat-option>` — şu an hiç schedule eşleşmez (kimse yazmıyor). Kullanılıyor mu? Filter dropdown'da boşa kalmış seçenek operasyonel kafa karışıklığı yaratır mı?

4. **LivePlanEntry → Schedule projeksiyon mapping**:
   - Mevcut frontend mapper IN_PROGRESS → ON_AIR çevirisi yapıyor (`schedule.service.ts:39`).
   - Bu çeviri ne zaman doğru? Schedule entity'sinin status'u DB'de DRAFT/CONFIRMED iken bile UI'da ON_AIR gözükür. Tutarsız.

5. **`event_duration_min` ve B5b ile bağlantı**:
   - Alternatif B (auto-derived from scheduleTime) `event_duration_min` gerektirir.
   - Kullanıcı dedi: "sahte canonical default kabul edilmedi" (B5b talimatı).
   - Bu yüzden B alt kullanılabilir görünmüyor.

6. **Cancellation semantiği**:
   - Schedule.status `CANCELLED` set ediliyor mu? Eğer evet — Schedule.status'i tamamen kaldırmak (Alternatif D) regresyon olur.
   - Hangi UI'da cancel butonu var? Yayın Planlama detail/edit'te mi?

7. **Hangi gruplar status değiştirebilir?**:
   - Mevcut `PERMISSIONS.schedules.write` = [Tekyon, Transmisyon, Booking, YayınPlanlama]
   - Manuel go-live için ayrı grup gerek mi? (Tekyon/Transmisyon makul; ama "yayın başlatma" yetkisi bilinçli olarak ayrı namespace ister miydi?)

---

## §6 — Implementation kararı yok

Bu doc preflight. Hiçbir implementation yapılmıyor. Kullanıcı bir alternatif seçtikten sonra ilgili kapsamda ayrı bir lock/requirement doc + implementation PR'ı planlanır.

---

## §7 — Review history

| Tarih | Yorum |
|-------|-------|
| 2026-05-11 | İlk preflight envanteri + 4 alternatif. MCR removal sonrası ON_AIR yazıcı boşluğu kayıt altında. Kullanıcı kararı bekleniyor. |
