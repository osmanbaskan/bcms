# Schedule/Yayın Planlama Frontend V1 (SCHED-B4)

> **Status**: ✅ Locked (2026-05-08). Implementation gate for SCHED-B4.
> **Tarih**: 2026-05-08
> **Cross-reference**:
> - `ops/REQUIREMENTS-SCHEDULE-BROADCAST-FLOW-V1.md` (K-B3.1-K-B3.27 — backend lock)
> - `ops/REQUIREMENTS-SCHEDULE-OPTA-SYNC-V1.md` (KO1-KO14 — OPTA cascade)
> - `ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md` §3.5 K16 (üst karar log)

## §0 — Status & cross-references

Bu doc SCHED-B4 frontend rewiring scope lock'unu kayıt altına alır. **Read-only frontend inventory + Y4-1..Y4-10 lock'lar + Playwright acceptance criteria**. Implementation ayrı PR; doc onayı sonrası başlar.

**İlişkili lock'lar:**
- **K22** (M5 Y2 revize): eski schedule-list "Canlı Yayın Plan" UI **DELETE** (Y2 disable iptal).
- **K-B3.1-K-B3.27**: backend broadcast flow contract (B3a/B3b) — UI bu API'ye bağlanır.
- **KO1-KO14**: OPTA cascade (B3c) — frontend cascade'i tetiklemez ama response sayaçlarını okur.

**AGENTS.md / CLAUDE.md `usageScope` notu**: AGENTS.md / CLAUDE.md içindeki `usageScope` "sole discriminator" ifadesi **stale** kabul edilir; SCHED requirement dokümanları üstün source of truth'tur. B5 destructive cleanup'ta `usage_scope` kolonu DROP edilecek; B4'te dokunulmaz. Ajan instruction dosyaları (AGENTS.md / CLAUDE.md) B5 turunda güncellenecek.

---

## §1 — Read-only frontend inventory

### §1.1 Nav menü (mevcut)

`apps/web/src/app/app.component.ts:546-548` (OPERASYON grubu):

```
"Canlı Yayın Plan"  → /schedules            (eski Schedule UI, usage_scope='live-plan' filtreli)
"Live-Plan (yeni)"  → /live-plan            (M5 yeni canonical)
"Stüdyo Planı"      → /studio-plan
"Ingest"            → /ingest               (Admin/Ingest)
...
"Raporlama"         → /schedules/reporting  (Admin)
```

### §1.2 Mevcut bileşenler

| Path | Açıklama |
|------|----------|
| `features/schedules/schedule-list/` | Eski "Canlı Yayın Plan" liste UI; `ScheduleFilter.usage='live-plan'` filtreli; **K22 ile DELETE hedefi** |
| `features/schedules/schedule-form/` | Eski Schedule create/edit form |
| `features/schedules/schedule-detail/` | Eski Schedule detay |
| `features/schedules/reporting/` | Schedule reporting (Admin); **B4'te dokunulmaz** |
| `features/live-plan/live-plan-list/` | M5 yeni canlı yayın plan liste |
| `features/live-plan/live-plan-detail/` | M5 yeni canlı yayın plan detay (segments) |
| `features/live-plan/admin-lookups/` | Lookup admin UI (M5-B6) |
| `core/services/schedule.service.ts` | Eski schedule CRUD; `/schedules` endpoint'leri |
| `core/services/api.service.ts` | `invalidateCache(pathPrefix?)` mevcut; mutation method'larında çağrılır |

### §1.3 Backend API surface (B3a/B3b/B3c)

| Endpoint | Açıklama |
|----------|----------|
| `POST /api/v1/schedules/broadcast` | Broadcast schedule create (K-B3.1-K-B3.27) |
| `PATCH /api/v1/schedules/broadcast/:id` | Broadcast schedule update |
| `DELETE /api/v1/schedules/broadcast/:id` | Broadcast schedule delete + live-plan channel NULL |
| `GET /api/v1/schedules?eventKey=...` | Mevcut list (eventKey filtre eklenebilir) |
| `GET /api/v1/live-plan` | Canlı yayın plan list (picker için) |
| `POST /api/v1/live-plan/from-opta` | OPTA seçim akışı (B3b) |
| `POST /api/v1/live-plan/:id/duplicate` | Duplicate (B3b) |

---

## §2 — Y4 Locked Decisions

### Y4-1 — B4 vs M5-B10b sıra: B4 önce

**Karar**: B4 frontend rewiring **önce**; M5-B10b 76 alan technical-details form **sonra**.

**Gerekçe**: Schedule UI rewire öncelik (operasyonel akış); M5-B10b live-plan-detail bileşeni iyileştirmesi B4'ten bağımsız çalışabilir, paralel risk düşük.

### Y4-2 — Frontend route: `/yayin-planlama`

**Karar**: Yeni Yayın Planlama UI route'u `/yayin-planlama` (Türkçe domain adı, kullanıcı bağlamı paritesi).

**Gerekçe**: Backend `/api/v1/schedules/broadcast` prefix'i (teknik) ↔ frontend kullanıcı domain'i (`yayin-planlama`) ayrımı. Kullanıcı menü/URL'de Türkçe görür; teknik prefix backend'e ait.

### Y4-3 — Backend API prefix değişmez

**Karar**: `/api/v1/schedules/broadcast` korunur; B4 kapsamı **frontend**.

**Gerekçe**: B3a backend lock'lu; B4 sadece UI rewire.

### Y4-4 — `/schedules` redirect

**Karar**: Eski `/schedules` route'u B4'te `/yayin-planlama`'ya redirect; eski `schedule-list.component.ts` bileşeni **B5 destructive cleanup'a kadar paralel kalır** (doğrudan navigate edilmez).

**Gerekçe**: K22 DELETE hedefi B5'te (kolon DROP + bileşen silme); B4'te redirect ile kullanıcı eski URL'lere düşmez. Reporting (`/schedules/reporting`) ayrık route, redirect'ten muaf.

### Y4-5 — `/schedules/reporting` korunur

**Karar**: Reporting UI mevcut konumda kalır; B4'te taşınmaz, dokunulmaz.

**Gerekçe**: Reporting domain ayrı revize gerektirebilir; B4'te taşımak gereksiz risk. Follow-up PR'a ertelenir.

### Y4-6 — Live-plan entry picker: dialog + filtre

**Karar**: Yayın Planlama formunda live-plan entry seçimi **full dialog** + filtre/search + tarih/status/team/eventKey kolonları.

**Gerekçe**: Yanlış event seçimi operasyonel hata doğurur; autocomplete tek başına zayıf. Dialog explicit confirmation pattern'i sağlar (lookup admin paritesi).

**Dialog özellikleri**:
- Filtre: tarih range (eventStartTime), status (PLANNED/READY/IN_PROGRESS), text search (title/team/optaMatchId)
- Tablo kolonları: title, team_1 vs team_2, eventStartTime, status, eventKey, sourceType (OPTA/MANUAL)
- Çift tıkla seç + "Seç" butonu
- Boş durum + sayfalama

### Y4-7 — Detail bileşeni MVP'den çıkar

**Karar**: `yayin-planlama-detail.component.ts` **MVP kapsamı dışı**. B4 MVP: liste + create/edit form (dialog veya page) + delete + picker.

**Gerekçe**: Detay route şart değil; entity DTO list'te + form'da görünür; ekstra route kapsamı büyütür. Detail gerekirse follow-up faz-2.

### Y4-8 — Playwright doğrulama zorunlu

**Karar**: B4 acceptance criteria olarak Playwright e2e test:

| Test | Kapsam |
|------|--------|
| Desktop screenshot | `/yayin-planlama` ana liste, create form, edit form, picker dialog (1920x1080) |
| Mobile screenshot | Aynı bileşenler (375x812) |
| Nav route kontrolü | `/yayin-planlama` menüden erişilebilir; `/schedules` redirect çalışıyor; `/live-plan` etkilenmedi |
| Create smoke | Picker'dan entry seç → form doldur → submit → liste güncel |
| Edit smoke | Liste'den item seç → edit form → submit → liste güncel |
| Delete smoke | Liste'den delete confirm → kayıt yok |
| Cache invalidation | Schedule mutation sonrası `/live-plan` listesi güncel (channel propagation tx); live-plan mutation sonrası `/yayin-planlama` listesi güncel (reverse sync) |
| Console/network error | Hiçbir adımda console.error veya 4xx/5xx network response (beklenen 409/412 hariç) |

**Çalıştırma**: `npx playwright test` veya proje config'i; CI gate olmasa bile manuel run zorunlu.

### Y4-9 — Plan dosyası yazıldı

**Karar**: Bu doc (`ops/REQUIREMENTS-SCHEDULE-FRONTEND-V1.md`) commit edilir; plan kararları kayıt altında.

### Y4-10 — Onay sonrası kod yazımı

**Karar**: B4 implementation onayı bu doc commit + push sonrası ayrı turda alınır. Doc'u onaylamak kod yazma izni **değil**; kod yazma için ayrı onay.

---

## §3 — Implementation checklist (B4 PR scope)

### §3.1 Nav cleanup

| Dosya | Değişiklik |
|-------|-----------|
| `apps/web/src/app/app.component.ts` | "Canlı Yayın Plan" route'u `/live-plan`'e değiştir; "(yeni)" label kaldır; "Yayın Planlama" yeni nav item ekle (`/yayin-planlama`, ikon `schedule` veya `event`); `/schedules` nav item kaldır |

### §3.2 Yeni feature: yayin-planlama

| Dosya | Sorumluluk |
|-------|-----------|
| `apps/web/src/app/features/yayin-planlama/yayin-planlama.routes.ts` | Route config (`/`, `/new`, `/:id/edit`) |
| `apps/web/src/app/features/yayin-planlama/yayin-planlama-list.component.ts` | Liste + filtre + edit/delete butonları |
| `apps/web/src/app/features/yayin-planlama/yayin-planlama-form.component.ts` | Create/edit form (Y4-7: route veya dialog karar implementasyonda) |
| `apps/web/src/app/features/yayin-planlama/live-plan-entry-picker.dialog.ts` | Dialog + filtre + search (Y4-6) |
| `apps/web/src/app/features/yayin-planlama/confirm-dialog.component.ts` | Delete onay (live-plan paritesi reusable; veya core/ui altına çıkar) |

### §3.3 Service + types

| Dosya | Değişiklik |
|-------|-----------|
| `apps/web/src/app/core/services/yayin-planlama.service.ts` (yeni) | `/api/v1/schedules/broadcast` CRUD; cache invalidation hook'ları |
| `packages/shared/src/types/...` | `BroadcastScheduleDto`, `CreateBroadcastScheduleDto`, `UpdateBroadcastScheduleDto` (B3a backend Zod paritesi); zaten varsa reuse |

### §3.4 ApiService cache invalidation

| Mutation | Invalidate path'leri |
|----------|---------------------|
| Schedule POST/PATCH/DELETE `/schedules/broadcast` | `/schedules`, `/live-plan` (channel propagation), `/live-plan/:entryId` |
| Live-plan POST/PATCH/DELETE `/live-plan` | `/live-plan`, `/schedules` (reverse sync) |
| Live-plan from-opta + duplicate | Aynı (yeni entry yaratır) |

### §3.5 Routing

| Path | Aksiyon |
|------|---------|
| `/yayin-planlama` | Yeni feature route (Y4-2) |
| `/schedules` | Redirect → `/yayin-planlama` (Y4-4) |
| `/schedules/reporting` | Korunur, dokunulmaz (Y4-5) |
| `/live-plan` | Korunur (Y4-1 — M5-B10b sonra) |

---

## §4 — Test/Playwright kapsamı (Y4-8)

### §4.1 Component spec (Angular Testing Utility)

- `yayin-planlama-list.component.spec.ts` — list render + filtre + edit/delete buton aksiyonları
- `yayin-planlama-form.component.spec.ts` — create + edit + validation (channel duplicate yasak, eventKey UNIQUE conflict 409)
- `live-plan-entry-picker.dialog.spec.ts` — filtre + selection
- `yayin-planlama.service.spec.ts` — CRUD + cache invalidation

### §4.2 Playwright e2e (zorunlu)

Yukarıdaki Y4-8 tablosu birebir test senaryolarına dönüştürülür:
- Desktop + mobile screenshot
- Nav route kontrolü
- Create/edit/delete smoke
- Cache invalidation cross-domain (schedule ↔ live-plan)
- Console/network error guard

**Çalıştırma**: `npm run e2e` veya `npx playwright test` (proje config'i tespit edilecek).

---

## §5 — Out of scope (B4 YAPMAZ)

- **B5 destructive cleanup**: eski `schedule-list.component.ts` DELETE, `usage_scope` kolon DROP, eski schedule-form/detail bileşenler silme, `/schedules` route DROP (redirect → tek yön; kalıcı redirect B5'te değerlendirilir)
- **M5-B10b**: 76 alan technical-details form (live-plan-detail iyileştirmesi) — Y4-1 sonra
- **PR-C2** (Madde 2+7): outbox shadow→pending cut-over + RabbitMQ direct publish disable
- **PR-D**: replay/retention/dedup/cleanup scope doc
- **Reporting UI** (`/schedules/reporting`): mevcut kalır (Y4-5)
- **Detail bileşeni**: MVP'den çıkarıldı (Y4-7)
- **OPTA sync UI**: B3c cascade backend sessizdir; frontend UI gerekmez

---

## §6 — Open follow-ups (B4 sonrası)

- M5-B10b technical-details form
- B5 destructive cleanup migration + bileşen silme + CLAUDE.md `usageScope` güncelleme
- audit.ts test export'lar `@internal` yorumu ile netleştirme (B5 turunda)
- "Yayın Planlama" detay bileşeni faz-2 değerlendirme

---

## §7 — Review history

| Tarih | Yorum |
|-------|-------|
| 2026-05-08 | Y4-1..Y4-10 lock'lu (B4 frontend scope). Plan dosyası yazıldı; B4 implementation onayı ayrı turda. |
