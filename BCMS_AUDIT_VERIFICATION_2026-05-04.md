# BCMS Audit Doğrulama Raporu

> **Tarih:** 2026-05-04
> **Yöntem:** 7 paralel verification subagent ile kod tabanına karşı somut delil (file:line + alıntı + komut çıktısı) tabanlı doğrulama.
> **Kaynak:** `BCMS_ULTRA_DETAILED_AUDIT_REPORT_2026-05-01.md` (3 gün önce yazılmış).
> **Amaç:** Kullanıcı raporun doğruluğundan şüphe etti — 189 maddenin tek tek doğrulanması.

---

## 1. Birinci Bulgu — Audit'in Kendi Sayıları Yanlış

Audit'in Section 1'deki executive summary tablosunda toplam **126 madde** raporlanıyor. Gerçek ID sayımı:

| Severity | Audit Section 1 iddia | Gerçek ID sayısı | Sapma |
|----------|------------------------|-------------------|-------|
| CRITICAL | 10 | 10 | ✓ |
| HIGH | 32 | **57** | +25 |
| MEDIUM | 34 | **57** | +23 |
| LOW | 32 | **44** | +12 |
| INFO | 18 | **21** | +3 |
| **Toplam** | **126** | **189** | **+63** |

Yani audit, kendi tablolarındaki bulgu sayısını **%50 eksik** raporlamıştır. Bu raporun executive summary güvenilirliği için ilk uyarı.

---

## 2. Doğrulama Sonuçları — Genel Özet

189 maddenin somut delil bazlı doğrulaması:

| Sınıf | Sayı | Oran |
|-------|------|------|
| ✅ **DOĞRU** — iddia kod gerçekliğiyle eşleşiyor | **157** | 83.1% |
| 🟡 **KISMEN** — konsept doğru, satır/kapsam/nitelendirme hatalı | **23** | 12.2% |
| ❌ **YANLIŞ** — iddia gerçeğe uymuyor | **4** | 2.1% |
| ⚠️ **FLU** — yoruma açık, eylem belirsiz | **4** | 2.1% |
| 🔄 **OUTDATED** — 2026-05-01'den sonra düzeltildi | **1** | 0.5% |

**Net değerlendirme:** Audit'in teknik içeriği ortalama olarak güvenilirdir (✅+🟡 = %95.3). Ancak hem sayım hatası, hem de düşük öncelikli kategorilerde (LOW, INFO) yanlış pozitif/abartı oranı yüksektir. CRITICAL bulgular **%100 doğrulandı** — bu, raporun en güvenilir kısmıdır.

---

## 3. Severity Bazlı Doğruluk Dağılımı

| Severity | Toplam | ✅ Doğru | ❌ Yanlış | 🟡 Kısmen | 🔄 Outdated | ⚠️ Flu | Doğruluk Oranı (✅) |
|----------|--------|----------|-----------|-----------|-------------|--------|---------------------|
| CRITICAL | 10 | 10 | 0 | 0 | 0 | 0 | **100.0%** |
| HIGH | 57 | 48 | 0 | 8 | 0 | 1 | 84.2% |
| MEDIUM | 57 | 43 | 2 | 12 | 0 | 0 | 75.4% |
| LOW | 44 | 38 | 2 | 1 | 1 | 2 | 86.4% |
| INFO | 21 | 18 | 0 | 2 | 0 | 1 | 85.7% |
| **Toplam** | **189** | **157** | **4** | **23** | **1** | **4** | **83.1%** |

**Yorum:**
- CRITICAL: %100 — raporun en titiz kısmı, hiçbir bulgu uydurma değil.
- MEDIUM: %75.4 — en zayıf kategorisi; 12 kısmen + 2 yanlış. Audit'in MED bulgularında abartı/satır kayması sık.
- HIGH ve LOW: orta seviyede güvenilir.

---

## 4. Yanlış Pozitif Bulgular (❌)

Bu 4 madde **rapordan kaldırılmalı veya yeniden yazılmalı**:

### ❌ MED-FE-015 — `audit-log.component.ts` `aria-label` eksik
**İddia:** `filterEntityId` input'unda `aria-label` yok.
**Gerçek:** `apps/web/src/app/features/audit/audit-log.component.ts:97-100` — `<mat-form-field><mat-label>Kayıt ID</mat-label><input matInput ... /></mat-form-field>`. Material `<mat-label>` matInput'u otomatik `aria-labelledby` ile bağlar. Ek `aria-label` çift labelleme olurdu.
**Aksiyon:** Madde silinmeli.

### ❌ MED-FE-016 — `mcr-panel.component.ts` setInterval cleanup race
**İddia:** "Hızlı create/destroy gap var; race condition."
**Gerçek:** `mcr-panel.component.ts:350-365` standart Angular timer pattern (`ngOnInit`'te declare, `ngOnDestroy`'da clear). Angular component lifecycle tek thread; "create/destroy gap" race teorik olarak da geçerli değil.
**Aksiyon:** Madde silinmeli.

### ❌ LOW-API-021 — `safeEqual` `Buffer.from(undefined)` patlaması
**İddia:** "Non-string input alırsa `Buffer.from(undefined)` patlar."
**Gerçek:** `apps/api/src/modules/ingest/ingest.routes.ts:90` `function safeEqual(a: string, b: string)` — TS imza string zorluyor. Tek çağrı yerinde (`:213 if (!received || !safeEqual(received, expected))`) zaten falsy guard var. Pratikte patlama yolu yok.
**Aksiyon:** Madde silinmeli veya "defensive typeof guard" diye revize edilmeli.

### ❌ LOW-FE-008 — `@for` `trackBy` eksik
**İddia:** `ingest-list` (detail rows), `audit-log` (chips) bazı `@for`'larda track yok.
**Gerçek:** Modern Angular `@for ... ; track` syntax track'i zorunlu kılıyor. `ingest-list.component.ts`'de 10/10, `audit-log.component.ts`'de 3/3 `@for` track içeriyor. Eksik bulunamadı.
**Aksiyon:** Madde silinmeli.

---

## 5. Outdated Bulgu (🔄) — Zaten Kapatılmış

### 🔄 LOW-API-004 — `schedule-list.component.ts:2070` Admin auto-augment dead code
**İddia:** `groups.includes(Admin) ? [...groups, SystemEng] : groups` ölü kod.
**Gerçek:** Audit'in yazıldığı 2026-05-01'in **aynı günü** commit `feed1d3` ile düzeltildi. Mevcut kod (`apps/web/src/app/features/schedules/schedule-list/schedule-list.component.ts:2070-2073`):
```ts
// 2026-05-01: Admin → SystemEng auto-augment kaldırıldı.
this._userGroups.set(groups);
```
**Aksiyon:** Section 9 (Çözülmüş bulgular) tablosuna taşı.

---

## 6. Flu Bulgular (⚠️) — Yoruma Açık, Eylem Belirsiz

### ⚠️ HIGH-SHARED-003 — `requestedByName` shared type'ta var
**İddia:** "DB'de yok ama base tipte" — yanlış yere konmuş.
**Gerçek:** `packages/shared/src/types/booking.ts:7` zaten `requestedByName?: string | null;` ile var. "Yanlış yer" iddiası tasarım yorumu — `BookingListItem extends Booking` ayrı tip oluşturma önerisi makul ama HIGH değil.
**Aksiyon:** Severity LOW'a indir veya kaldır.

### ⚠️ LOW-API-013 — `updateScheduleSchema` `broadcastTypeId` yok
**İddia:** "Kasıtlı mı doğrula."
**Gerçek:** Tasarım kasıtlı (broadcastTypeId create-only). Audit'in kendisi bile "verify intent" diyor; eylem belirsiz.
**Aksiyon:** Schema'ya `// broadcastTypeId is create-only` yorumu ekle, raporu kaldır.

### ⚠️ LOW-API-024 — `metrics.ts` Counter overflow
**İddia:** "`Number.MAX_SAFE_INTEGER` aşabilir (teorik)."
**Gerçek:** prom-client Counter JS number kullanır (~9×10^15). 1M req/s'de 285 yıl gerekir. Audit zaten "(teorik)" diyor.
**Aksiyon:** Won't fix.

### ⚠️ INFO-019 — Backup retention + restore drill 110→110
**İddia:** "7 gün + 4 hafta + 6 ay retention; restore drill 110→110 OK."
**Gerçek:** Retention konfig `docker-compose.yml:40-42`'de doğru. Ama "restore drill 110→110 OK" runtime/operasyonel test sonucu — kod tabanından doğrulanamaz; runbook/log kanıtı gerekli.
**Aksiyon:** İddiayı runbook referansıyla destekle veya genelleştir.

---

## 7. Kısmen Doğru Bulgular (🟡) — Konsept Doğru, Detay Hatalı

23 madde "konsept doğru ama" kategorisinde. Aşağıdaki tipik hatalar tekrar ediyor:

### A. Satır numarası kayması (off-by-N)
| ID | Audit satır | Gerçek satır | Sapma |
|----|-------------|--------------|-------|
| HIGH-API-005 | 93-110 | 165-197, 232-249 | yardımcı fn ile karıştırılmış |
| HIGH-API-007 | 19-21 | 20-22 | -1 |
| HIGH-API-017 | 332 (ingest.routes.ts) | 357 | -25 |
| MED-FE-009 | 111 | 114 | -3 |
| MED-FE-010 | 2107-2115 | 2065-2066 | +40 |
| MED-FE-013 | 244-245 | 247 | -2-3 |
| MED-INF-006 | 289 (grafana) | 296 | -7 |

### B. Risk abartısı / scope abartısı
- **HIGH-FE-004** (`::ng-deep` 4 dosya): listede `ingest-port-board` yok ama `studio-plan-toolbar.scss` var.
- **HIGH-FE-011** (child route'lar korunmasız): tüm child'larda `canActivate: [AuthGuard]` zaten var; "korunmasız kalabilir" iddiası yanlış.
- **HIGH-API-015** (Keycloak 13 HTTP): kısmi cache var (`groupMembershipCache`, `groupIdMapCache`) ama listing-level cache yok.
- **HIGH-API-018** (chokidar): "referans saklanmıyor" yanlış (lokal var var); ama `onClose` cleanup yok.
- **HIGH-API-019** (`trustProxy`): rate-limit zaten x-real-ip ile doğru hesaplanıyor; sadece audit IP yanlış.
- **HIGH-SHARED-004** (`updatedAt` eksik): Booking'de zaten var, IngestPlanItem'da var; sadece IngestJob'da yok.
- **MED-API-004** ("hard delete + create"): hard delete yok, find-or-skip-or-create var; ama `bxfEventId` unique index yok kısmı doğru.
- **MED-API-016** (`ANY()::text[]` cast): teorik; Prisma 5 tagged template otomatik bind ediyor.
- **MED-API-017** (metadata JSON filter `optaMatchId`): CLAUDE.md kuralı sadece `usageScope` için.
- **MED-FE-007** (loading flag yok): `optaCompsLoading` zaten var.
- **MED-FE-013** (source-pill renk-only): metin de var (`{{ row.sourceLabel }}`).
- **MED-FE-014** (zoom buton aria-label): parent grup `aria-label="Zoom Seviyesi"` var, butonlar görünür metin içeriyor.
- **MED-SHARED-007** (web tip drift): yerel tipler view-model, drift riski sınırlı.
- **LOW-FE-001** (inline CSS bloat): "1000 satır" iddiası abartılı; gerçek schedule-list 292, ingest-list 97.
- **INFO-016** (opta-watcher non-root): Dockerfile'da `USER` yok; runtime'da `runuser` ile düşürülüyor.
- **INFO-017** (healthcheck listesi): Prometheus + Grafana eksik (audit'ten sonra eklendi).

### C. Mükerrer kayıt
- **HIGH-SHARED-007 = MED-SHARED-006**: `JwtPayload.email` zorunlu — aynı bulgu hem HIGH hem MED'de listelenmiş.

### D. Yanlış kategorize
- **LOW-API-004**: aslında frontend kodu (`schedule-list.component.ts`), API kategorisinde listelenmiş.

---

## 8. Sonuç ve Tavsiyeler

**Audit'in genel kalitesi:** Kabul edilebilir-iyi. CRITICAL bulguların tümü doğrulandı; bu raporun en güvenilir kısmı. Aksiyon kararları için kullanılabilir.

**Şüpheyle yaklaşılması gereken alanlar:**
1. **Section 1 sayım tablosu** — gerçek bulgu sayısı 189, raporda 126 yazıyor.
2. **MED kategorisi** — %25 kısmen/yanlış oranı; yorum/abartı sık.
3. **Pozitif gözlemler (INFO)** — runtime/operasyonel iddialar (drill, healthcheck listesi) güncellik takibi gerektiriyor.

**Acil aksiyonlar (rapor üzerinde):**
- ❌ olarak işaretlenen 4 madde silinmeli/revize edilmeli (MED-FE-015, MED-FE-016, LOW-API-021, LOW-FE-008).
- 🔄 LOW-API-004 "çözülmüş" olarak Section 9'a taşınmalı.
- Section 1 tablosu gerçek sayılarla düzeltilmeli (10/57/57/44/21).
- Mükerrer kayıt (HIGH-SHARED-007 = MED-SHARED-006) tek satıra indirilmeli.
- LOW-API-004 frontend kategorisine taşınmalı (LOW-FE).

**Kullanım kararı:** Raporun CRITICAL ve HIGH kısımları aksiyon planlarında güvenli temel oluşturur. MEDIUM ve aşağısı sprint planlamada kullanmadan önce tek tek `git grep` ile re-verify edilmeli.

---

## 9. Doğrulama Yöntemi

7 paralel subagent, her biri belirli bir batch için:

| Subagent | Kapsam | Madde |
|----------|--------|-------|
| 1 | CRITICAL | 10 |
| 2 | HIGH-API + HIGH-SHARED | 26 |
| 3 | HIGH-FE + HIGH-INF | 31 |
| 4 | MED-API + MED-SHARED | 32 |
| 5 | MED-FE + MED-INF | 25 |
| 6 | LOW-API + LOW-SHARED | 27 |
| 7 | LOW-FE + LOW-INF + INFO | 38 |
| **Toplam** | — | **189** |

Her subagent için zorunlu kural: somut delil (file:line + alıntı veya komut çıktısı) olmadan ✅ verilmemesi.

Tools: Read, Grep, Bash. Docker runtime durumu için: `docker compose ps`, `docker exec`. Numerik iddialar için: `wc -l`, `grep -c`, `psql`.

Toplam tool çağrısı: ~380. Toplam wall-clock: ~5 dk (paralel).

---

*Bu rapor `BCMS_ULTRA_DETAILED_AUDIT_REPORT_2026-05-01.md` raporunun doğruluğunu test eder; o raporu yerine geçmez. İkisi birlikte okunmalıdır.*
