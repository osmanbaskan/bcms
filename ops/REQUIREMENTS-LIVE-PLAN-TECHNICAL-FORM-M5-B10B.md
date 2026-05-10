# Live Plan Teknik Form — M5-B10b Preflight

> **Status**: 📋 Preflight + tasarım (implementation YOK; UI APPROVAL gerekli).
> **Tarih**: 2026-05-11
> **Cross-reference**: `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md`, `ops/REQUIREMENTS-LIVE-PLAN-TECHNICAL-FIELDS-V1.md`, M5-B6 done (`aa168f1` admin-lookups), M5-B10a done (`a7457ff` segments-only scaffold).

---

## §1 — Mevcut backend kapasitesi

### §1.1 `live_plan_technical_details` tablosu (M5-B7 done, schema lock)

`apps/api/prisma/schema.prisma:1056` model. 1:1 parent `live_plan_entries`. 73 yapılandırılmış alan (76'dan 3 audit/lifecycle: createdAt, updatedAt, deletedAt). Optimistic locking `version` kolonu (K9).

### §1.2 Alan grupları (DB lock, 6 grup)

| Grup | Alan sayısı | Türler |
|------|-------------|--------|
| §5.1 Yayın/OB | 14 | Lookup FK (10) + text (2) + int (2) |
| §5.2 Ortak | 10 | Timestamptz (2) + Lookup FK (8) |
| §5.3 IRD/Fiber | 5 | Lookup FK (5) |
| §5.4 Ana Feed | 21 | Lookup FK (12) + text (9) |
| §5.5 Yedek Feed | 19 | Aynı pattern + backup prefix |
| §5.6 Fiber | 4 | Lookup FK (3) + text (1) |
| **Toplam** | **73 alan** | |

### §1.3 Lookup tabloları (M5-B4..B5 done, 25 tablo)

`ops/REQUIREMENTS-LIVE-PLAN-TECHNICAL-FIELDS-V1.md` whitelist'i şu lookup tipleri:
- `broadcast_locations`, `ob_van_companies`, `generator_companies`, `jimmy_jib_companies`, `steadicam_companies`, `sng_companies`, `carrier_companies`, `regions`, `usage_locations`
- `ib_machines` (IBM), `hdvg_resources`, `int_resources` (int1/int2 paylaşır), `off_tubes`, `languages`, `demods`, `ties`, `virtual_resources`
- `irds` (ird1/ird2/ird3 paylaşır), `fibers` (fiber1/fiber2 paylaşır)
- `feed_types`, `satellites`, `polarizations` (uplink+downlink+backup paylaşır), `modulation_types`, `roll_offs`, `video_codings`, `audio_configs` veya `transmission_audio_configs`, `iso_feeds`, `key_types`, `fec_rates`
- `fiber_companies`, `fiber_audio_formats`, `fiber_video_formats`
- `technical_companies` (polymorphic; type ile filtrelenir — 6+ rol için tek tablo)

`packages/shared/src/types/live-plan.ts` veya runtime'da `lookup.registry.ts` whitelist'inden alan→lookup type eşleştirmesi vardır (M5-B4 lock).

### §1.4 API endpoint (M5-B9 done)

- `GET /api/v1/live-plan/:entryId/technical-details` — full entity döner; `version` includes
- `PATCH /api/v1/live-plan/:entryId/technical-details` — partial update + `If-Match: <version>` zorunlu
- Lookup dropdown source: `GET /api/v1/live-plan/lookups/:type` (M5-B5 done)

### §1.5 Frontend mevcut durumu (M5-B10a done, scaffold)

`apps/web/src/app/features/live-plan/` altında:
- `admin-lookups/` (M5-B6 done) — operatör SystemEng lookup CRUD'u
- `live-plan-detail/` (M5-B10a done) — **segments-only scaffold**: `live_plan_transmission_segments` UI (1:N child); technical-details için sadece placeholder
- `live-plan-list-component` (M5-B2'den)
- `mat-table` + `MatDialog` pattern, signals + ngModel (admin-lookups paritesi)

---

## §2 — Mantıksal alan grupları (UI form tasarımı)

Backend §5.1-5.6 yapılandırması zaten 6 grup. Form UI tarafında bunlar **6 mantıksal sekme** veya **6 katlanır bölüm** olabilir:

| Form sekmesi/bölümü | Backend grubu | Alan adedi | Lookup endpoint tipleri |
|---------------------|---------------|------------|------------------------|
| 1. Yayın & OB | §5.1 | 14 | broadcast_locations, ob_van_companies, generator_companies, jimmy_jib (technical_companies type=jimmy_jib), steadicam (technical_companies), sng_companies, carrier_companies, ib_machines, usage_locations, regions, secondObVan (ob_van_companies tekrar) |
| 2. Ortak | §5.2 | 10 | timestamptz (2 datetime input) + hdvg_resources, int_resources, off_tubes, languages, demods, ties, virtual_resources |
| 3. IRD & Fiber Slot | §5.3 | 5 | irds (3 slot), fibers (2 slot) |
| 4. Ana Feed | §5.4 | 21 | feed_types, satellites, polarizations (2: uplink/downlink), modulation_types, roll_offs, video_codings, audio_configs, iso_feeds, key_types, fec_rates + 9 text input |
| 5. Yedek Feed | §5.5 | 19 | aynı set (backup prefix) + 8 text input |
| 6. Fiber Detay | §5.6 | 4 | fiber_companies, fiber_audio_formats, fiber_video_formats + 1 text |

**Alternatif**: tek `mat-accordion` (collapsible panel'lar) — 1 sayfa, 6 panel, default ilki açık. Mobil/tablet'te toplu görüntüleme.

**Önerim**: `mat-accordion` (6 panel). Sebep:
- Operatör tüm değerleri tek ekranda görür (kaydırma)
- Sekme switching focus state'i kaybeder; long-form için kötü UX
- Material spec accordion bu kapsam için doğru pattern

---

## §3 — Form component yapısı

### §3.1 Önerilen dosya hiyerarşisi

```
apps/web/src/app/features/live-plan/live-plan-detail/
  technical-details-panel.component.ts          ← ana panel (router-outlet veya parent live-plan-detail içinde)
  technical-details-form.component.ts           ← reactive/template-form (signals + ngModel)
  technical-details-form.types.ts               ← TS types (FormState, dirty tracking)
  groups/
    yayin-ob-group.component.ts                 ← §5.1 (14 alan)
    ortak-group.component.ts                    ← §5.2 (10 alan)
    ird-fiber-group.component.ts                ← §5.3 (5 alan)
    main-feed-group.component.ts                ← §5.4 (21 alan)
    backup-feed-group.component.ts              ← §5.5 (19 alan)
    fiber-group.component.ts                    ← §5.6 (4 alan)
  lookup-select.component.ts                    ← reusable mat-select bound to /lookups/:type
```

### §3.2 Reusable lookup-select component

Tek bir reusable component, lookup'a göre parametrize:

```ts
@Component({
  selector: 'app-lookup-select',
  template: `
    <mat-form-field>
      <mat-label>{{ label }}</mat-label>
      <mat-select [(ngModel)]="value" [ngModelOptions]="{standalone:true}" (selectionChange)="changed.emit($event.value)">
        <mat-option [value]="null">— Seçiniz —</mat-option>
        @for (item of items(); track item.id) {
          <mat-option [value]="item.id">{{ item.label }}</mat-option>
        }
      </mat-select>
    </mat-form-field>
  `
})
export class LookupSelectComponent {
  @Input() label!: string;
  @Input() lookupType!: LookupType;      // whitelist enum
  @Input() value: number | null = null;
  @Output() changed = new EventEmitter<number | null>();

  items = signal<LookupItem[]>([]);
  ngOnInit() { /* fetch /api/v1/live-plan/lookups/:type, cache via ApiService */ }
}
```

### §3.3 ApiService cache

73 alan içeren form ~20-25 lookup endpoint çağrısı yapar (her tip için 1). Sayfa açılışında **paralel pre-fetch** + ApiService cache:
- Component init'te `Promise.all([...lookupTypes.map(t => apiService.fetchLookup(t))])`
- ApiService'te 5-10 dk TTL cache (lookup master data sık değişmez)
- Y2 REVIZE: schedule-list disable patternine benzer (cache + invalidation)

---

## §4 — Validation önerisi

### §4.1 Server-side (backend zaten lock'lu)

M5-B9 service zaten:
- Polymorphic lookup type validation (`technical_companies.type` immutable)
- Soft-deleted lookup FK rejection (`active=true AND deletedAt IS NULL`)
- Optimistic locking (`If-Match: <version>`)
- 76 alanın hepsi `Json` değil structured kolon — type safety zaten DB'de

### §4.2 Client-side

Reactive validation gereği düşük (server zaten guard). Sadece:
- Datetime alanları: `plannedStartTime < plannedEndTime` (custom validator)
- Required alan yok (hepsi opsiyonel; operatör aşamalı doldurma)
- `version` field hidden (read-only; PATCH header'a kopyalanır)
- "Dirty" state takibi: `pristine` → save butonu disabled

### §4.3 Submit pattern

PATCH body partial:
```ts
{
  // sadece değişen alanlar
  broadcastLocationId: 5,
  obVanCompanyId: null,        // clear
  // version → If-Match header
}
```

Server `If-Match` mismatch → 412 → snack + reload (caller). admin-lookups paritesi.

---

## §5 — UI riskleri

| Risk | Etki | Mitigasyon |
|------|------|------------|
| 73 alan, 25 lookup endpoint, 6 grup → **karmaşık form**, ilk açılışta yavaş | Operatör algıladığı performans düşük | Lookup pre-fetch parallel + cache; loading state per group |
| Polymorphic `technical_companies` filter | Yanlış type seçilirse "yanlış dropdown" | Form helper `companyType` parametresi ile filter; backend zaten reddeder |
| Mobil görünüm | 73 alanı mobil ekrana sığdırmak zor | Accordion panel'lar mobile'da tek kolon stack — Material default |
| Operatör data fill mode | Boş tabloları doldurmak zaman alır (M5-B6 lookup admin gerek) | M5-B6 done; operatör admin UI'sından önce lookup'ları doldurur |
| Optimistic lock conflict (operatör eşzamanlı edit) | 412 → yeniden çek → kaybedilen edit | Snack mesajı + load() ile taze veri; admin-lookups paritesi |
| Lookup name değişimi | Cache stale | TTL kısa (5 dk) veya invalidate-on-admin-edit |
| Touch/click target boyut | Accordion panel header tıklama zorluğu | Material accordion default ergonomi |
| Save buton konum | Long-form'da operatör panel sonunda kaybolur | Sticky bottom toolbar (Material `mat-toolbar` sticky) |
| Field label dili | Türkçe tutarlılığı | Helper file `field-labels.ts` — tek tek seed |

---

## §6 — Implementation komutu taslağı

Kullanıcı UI APPROVAL verdiğinde:

```
M5-B10b implementation — live-plan technical details form.

Frontend (UI APPROVAL gerekli):
- apps/web/src/app/features/live-plan/live-plan-detail/
  - technical-details-panel.component.ts (ana panel, mat-accordion 6 panel)
  - technical-details-form.component.ts (signals + ngModel + dirty tracking)
  - lookup-select.component.ts (reusable mat-select bound to lookup endpoint)
  - groups/yayin-ob-group, ortak-group, ird-fiber-group, main-feed-group,
    backup-feed-group, fiber-group (6 component, her biri ilgili alanlar)
- Field label helper (Türkçe etiketler, tek dosya seed).
- ApiService cache: getLookup(type, ttl=5min) + invalidate.
- live-plan-detail routing: /live-plan/:id technical-details panel'i açar
  (mevcut M5-B10a segments paneli ile yan yana).
- Save flow: PATCH /api/v1/live-plan/:entryId/technical-details
  + If-Match header; 412 → snack + reload.

Backend (mevcut, dokunulmuyor):
- M5-B7 schema lock — 73 alan stable
- M5-B9 service + routes done
- M5-B5 lookup generic CRUD done

Tests:
- Karma: technical-details-form.spec.ts
  - 6 grup render
  - lookup-select fetch + cache
  - dirty save patch
  - 412 conflict snack + reload
- Integration: yok (backend zaten done)

Verification:
- npm run build -w apps/web (EXIT=0)
- Karma focused: technical-details-form + admin-lookups + live-plan-list
- Smoke: GET /live-plan/:entryId/technical-details 200, PATCH 200, stale If-Match 412
- docker compose config (no warnings)

Out of scope (separate turns):
- Reporting B5b (still BLOCKED)
- M5-B11 ingest FK, M5-B12 studio FK, M5-B13/B14 cleanup
- Live-plan list virtual scroll if perf needed
```

---

## §7 — Kullanıcı kararları

1. **Accordion mu sekme mi?** Öneri: accordion (6 panel, ilki default açık).
2. **Sticky save toolbar mı, panel başı save buton mu?** Öneri: sticky bottom.
3. **Lookup TTL** (cache süresi)? Öneri: 5 dakika; admin-lookups CRUD sonrası invalidate.
4. **Operatör data-fill onboarding**: 25 lookup tablo boş başlar (M5-B4 lock); operatör hangi sırayla doldurur? Doc ekli mi olmalı?
5. **Polymorphic `technical_companies`**: ob_van_companies vs jimmy_jib vs steadicam vs sng vs carrier vs fiber_companies — hepsi tek tablo `type` ile mi yoksa ayrı lookup endpoint'i mi? (Şu an scheme'a göre tek tablo polymorphic; route filter ekliyor olmalı.)
6. **Validation kapsamı**: server-side yeterli mi, yoksa template-driven required işaretleri istenir mi (operatör onboarding için)?
7. **Form pattern**: signals + ngModel mı (admin-lookups paritesi) yoksa reactive form mu? Öneri: signals + ngModel.

---

## §8 — Implementation kararı yok

Bu doc preflight. Hiçbir implementation yapılmıyor. UI APPROVAL alındıktan sonra §6 şablonundaki implementation isteğine geçilir.

---

## §9 — Review history

| Tarih | Yorum |
|-------|-------|
| 2026-05-11 | İlk M5-B10b preflight. 73 alan, 6 grup, accordion önerisi, reusable lookup-select, ApiService cache, 7 açık soru. UI APPROVAL bekleniyor. |
