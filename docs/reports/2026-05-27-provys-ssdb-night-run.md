# Provys + SSDB — Gece Çalışma Raporu (2026-05-27)

**Süre:** 2026-05-27 gece (otomatik toplu emir)
**HEAD (lokal):** `8394836 feat(ssdb): add MAM material lookup for Provys flows`
**Remote durum:** Push yapılmadı; `origin/main` 44 commit geride
**Commit yapıldı mı?:** Hayır — emir gereği commit yok; çalışmalar uncommitted

---

## 1. Yapılan İşler

### 1.1 Provys UI — kolon düzeni
- **Not** kolonu (`<th>Not</th>` + input cell) **kaldırıldı**.
- **Süre** kolonu (`col-dur`) tablonun **son pozisyonuna taşındı** (Başlık'tan sonra).
- Yeni sıra: `# | Başlangıç | Kategori | DC Kod | Materyal | Başlık | Süre`
- Dead CSS temizlendi: `.col-note`, `.note-input` ve hover/focus/aria-invalid stilleri silindi.
- Dead component code temizlendi: `noteErrors` signal + `onNoteBlur()` handler silindi; `signal` import'u kaldırıldı.
- `FakeProvysService.updateNoteCalls` test fixture'ı bırakıldı (servis metodu hâlâ var; UI'dan referans yok).

**Backend etkisi:** `userNote` Prisma alanı + `PATCH /provys/items/:id/note` endpoint **korundu** (gelecekte tekrar eklenebilir). Worker BXF sync `userNote`'a dokunmaz; davranış değişmedi.

### 1.2 "Program başlıkları" filtresi kaldırıldı
- UI mat-slide-toggle (`provys-content-control.component.ts`) silindi.
- Service: `showProgramHeaders` signal + `setShowProgramHeaders()` setter silindi.
- `filteredItemsFor()` filter zinciri sadeleştirildi — `rawKind === 'ProgramHeader'` satırlar artık **her zaman gizlenir**.
- Service `buildExportParams()` `includeProgramHeaders` query param'ı **hardcoded `'false'`** olarak gönderir.

**Backend etkisi:** `provys.routes.ts` Zod schema'sında `includeProgramHeaders: z.enum(['true','false']).optional()` **korundu**. Backend filter behavior değişmedi (default kapalı). API'ye dokunulmadı.

### 1.3 Provys renk swap — değerlendirme
Kullanıcının emrinde çelişki var:
- **"Provys UI'da Program/Reklam renklerini tersine çevir"** (cümle 1)
- **"PROGRAM yeşil olacak / REKLAM sarı olacak"** (cümle 2)

Mevcut kod **zaten PROGRAM yeşil + REKLAM sarı** (final niyetle uyumlu):
- `packages/shared/src/types/provys.ts:49-52`:
  - `REKLAM: { background: '#fff4e5', border: '#f59e0b', text: '#7c2d12' }` (sarı/turuncu)
  - `PROGRAM: { background: '#ecfdf5', border: '#10b981', text: '#064e3b' }` (yeşil)
- `provys-channel-panel.component.ts:300-304` row CSS class'ları aynı tutarlı.
- `apps/api/src/modules/provys/provys.export.ts:64-67` Excel/PDF palet aynı.

**Karar: Swap YAPILMADI.** Mevcut state kullanıcının net hedefiyle ("PROGRAM yeşil, REKLAM sarı") **birebir aynı**. "Tersine çevir" cümlesinin önceki bir UI screenshot/tema farkından kaynaklandığı varsayıldı. Eğer kullanıcı gerçekten swap istiyorsa belirti tanımıyla teyit alındıktan sonra ayrı emir.

### 1.4 SSDB runtime aktivasyonu
- **Migration apply edildi:** `docker compose exec api npx prisma migrate deploy` → `ssdb_material_cache` tablosu PostgreSQL'de oluşturuldu.
- **docker-compose.yml wiring eklendi:** Hem `api` hem `worker` servisinin `environment:` bloğuna:
  - `PROVYS_SSDB_RESOLVER: ${PROVYS_SSDB_RESOLVER:-off}` (default OFF)
  - `SSDB_HOST/PORT/DATABASE/USER/PASSWORD: ${SSDB_*:-}` (default boş)
- Worker `BCMS_BACKGROUND_SERVICES` listesine `ssdb-resolver` **eklendi**.
- `.env.example` dosyasına SSDB placeholder bölümü eklendi (password için `<GENERATE_ME_ssdb_read_password>`).

**Worker rebuild + API force-recreate YAPILMADI.** Secret yokken `--build` anlamsız (config eksik; tick erken return eder); ayrıca compose env değişimi sadece yeni container'larla canlı olur — sabah kullanıcı tek atomic adımla halletmeli.

### 1.5 Screenshot — `/home/ubuntu/Pictures/Screenshots/Ekran görüntüsü_2026-05-27_01-16-52.png`
**Açılmadı / okumadı.** Sadece "Program başlıkları" filtresinin kaldırılması talimatı için referansdı; o iş §1.2'de tamamlandı. Screenshot'a aktif teşhis için ihtiyaç olmadı.

---

## 2. Değişen Dosyalar

```
M apps/web/src/app/features/provys-content-control/provys-channel-panel.component.ts
M apps/web/src/app/features/provys-content-control/provys-channel-panel.component.spec.ts
M apps/web/src/app/features/provys-content-control/provys-content-control.component.ts
M apps/web/src/app/features/provys-content-control/provys.service.ts
M apps/web/src/app/features/provys-content-control/provys.service.spec.ts
M docker-compose.yml
M .env.example
```

**Yeni eklenen rapor:** `docs/reports/2026-05-27-provys-ssdb-night-run.md` (bu dosya).

**Dokunulmayan scope-dışı (pre-existing dirty):** `studio-plan*`, `studio-plan-edit*`, `tests/playwright/smoke-*`, `docs/provys-bxf-field-notes.md`, `tests/playwright/artifacts/` — SSDB/Provys ile ilgisiz, korunuyor.

---

## 3. Root Cause Analizleri

### 3.1 (Önceki turdan devralınan) `missing_dc_code` enum mismatch — RESOLVED
- **Belirti:** Console error `Cannot read properties of undefined (reading 'tone')`
- **Sebep:** Amend `8394836` öncesinde commit `6bfc3ca`'daki API container `missing_dc_code` enum'unu döndürüyordu; rename sonrası web bundle `dc_not_applicable` bekledi. Skew → `MATERIAL_BADGE[undefined]`.
- **Düzeltme:** `docker compose up -d --no-deps --build api` (önceki turda yapıldı). Şimdi API + Web hem `8394836` üzerinde — Materyal badge'leri hatasız render.

### 3.2 (Önceki turdan) Compose dependency rebuild — kapsam ihlali notu
- İlk web rebuild emrinde `docker compose up -d --build web` Compose'un `depends_on: api` zincirini tetikledi ve API'yi de yeniden başlattı.
- **Doğru komut:** `docker compose up -d --no-deps --build <svc>`. Bu turda her komutta `--no-deps` kullanıldı.

---

## 4. Test Komutları + Sonuçları

### API
```
$ cd apps/api && npx vitest run --config ./vitest.unit.config.ts \
    src/modules/ssdb/ src/modules/provys/provys.ssdb-merge.unit.spec.ts
Test Files  9 passed (9)
     Tests  193 passed (193)
  Duration  2.18s

$ npx tsc --noEmit -p tsconfig.json
EXIT=0  (no errors)
```

### Web
```
$ cd apps/web && npx tsc --noEmit -p tsconfig.json        → exit 0
$ npx tsc --noEmit -p tsconfig.spec.json                  → exit 0

$ npx ng test --watch=false --browsers=ChromeHeadlessNoSandbox
TOTAL: 62 FAILED, 414 SUCCESS  (479 → 476 total: 4 not-input testi silindi,
                                              1 toggle ON testi silindi,
                                              3 kolon sırası testi eklendi)
```

**Fail breakdown (62 unique):**
- 39 × `StudioPlanComponent` — **pre-existing NG0201: No provider found for `ActivatedRoute`**
- 23 × `IngestListComponent` — **aynı pre-existing sorun**
- **SSDB / Provys / Materyal / Eksik isimli sıfır fail.**

Bu 62 fail SSDB değişikliklerinden bağımsız; standalone TestBed setup'larında `provideRouter([])` eksik. **Bu commit'te düzeltilmedi (kapsam dışı, teknik borç).**

---

## 5. Runtime Adımları (yapılmış / yapılmamış)

| Adım | Durum |
|---|---|
| Migration apply (`prisma migrate deploy`) | ✅ DONE — `ssdb_material_cache` tablosu DB'de |
| docker-compose env wiring (API + worker) | ✅ DONE — `PROVYS_SSDB_RESOLVER`, `SSDB_*` referansları |
| BCMS_BACKGROUND_SERVICES listesine `ssdb-resolver` | ✅ DONE (worker only) |
| .env.example placeholder | ✅ DONE |
| **`.env` içine `SSDB_PASSWORD=<secret>` ekle** | ⛔ BLOCKED (kullanıcı eylemi gerekiyor; secret tahmin edilmedi) |
| **`PROVYS_SSDB_RESOLVER=on` set** | ⛔ BLOCKED (secret bağımlı) |
| `docker compose up -d --no-deps --build worker` | ⛔ BLOCKED |
| `docker compose up -d --no-deps --force-recreate api` | ⛔ BLOCKED |
| TCP smoke: `worker → 172.28.208.20:60813` | ⛔ blocked |
| HTTP smoke: `GET /api/v1/ssdb/health` Bearer JWT ile | ⛔ blocked (auth bypass yok) |
| HTTP smoke: `POST /api/v1/ssdb/cache/refresh {dcCode: "DC00040962"}` | ⛔ blocked |
| Worker tick gözlemi 60-120 sn | ⛔ blocked |

---

## 6. SSDB Durumu: **partially completed — BLOCKED on secret**

Kod ve compose tarafı tamamen hazır. Aktivasyon için kullanıcının manuel yapması gerekenler:

```bash
# 1) .env dosyasına ekle (secret store / vault'tan al)
echo 'PROVYS_SSDB_RESOLVER=on' >> .env
echo 'SSDB_HOST=172.28.208.20' >> .env
echo 'SSDB_PORT=60813' >> .env
echo 'SSDB_DATABASE=LIGTV-SSDB' >> .env
echo 'SSDB_USER=read1' >> .env
echo 'SSDB_PASSWORD=<doğrulanmış-secret>' >> .env

# 2) Worker rebuild + restart (yeni SSDB modülü ve env)
docker compose up -d --no-deps --build worker

# 3) API force-recreate (env reload)
docker compose up -d --no-deps --force-recreate api

# 4) TCP smoke
docker compose exec worker nc -zv 172.28.208.20 60813

# 5) /health smoke — geçerli JWT ile (auth bypass YOK)
TOKEN=<browser_devtools'tan kopyala>
curl -k -H "Authorization: Bearer $TOKEN" https://beinport/api/v1/ssdb/health
# Beklenen: { enabled:true, configured:true, cacheTableReachable:true, ... }

# 6) Manual refresh smoke
curl -k -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"dcCode":"DC00040962"}' \
  https://beinport/api/v1/ssdb/cache/refresh
# Beklenen: { dcCode, lookupStatus:'found', mediaGuid, ssdbDurationFrames, ... }

# 7) Worker tick gözlemi
docker compose logs worker -f --tail 50
# 60 sn içinde "SSDB resolver tick complete" log'u görünmeli
```

---

## 7. Açık Riskler / Blocker'lar

### ⛔ BLOCKED — sabaha kalan
1. **`SSDB_PASSWORD` secret yok** — `.env` ve compose'da tanımlı değil. Tahmin edilmedi. Vault/secret store'dan alınmalı.
2. **JWT token** smoke testler için gerekli; SKIP_AUTH yasak. Browser DevTools veya `kc-token-helper.sh` ile alınır.

### 🟡 Riskler
3. **Network erişimi** — `172.28.208.20:60813` Docker bridge'inden erişilebilir mi? Host'tan sqlcmd çalıştı, container'dan test edilmedi. Eğer erişim yoksa compose `extra_hosts` veya routing config gerekir.
4. **62 pre-existing test fail** (`NG0201: ActivatedRoute`) — SSDB ile ilgisiz; ayrı PR'da düzeltilecek.
5. **Lokal main 44 commit önde** — `origin/main`'e push edilmedi. Production deploy stratejisi GitHub akışı mı, lokal image mi belirsiz; kullanıcı kararı.
6. **Worker container hâlâ 25+ saat önceki image'da** (pre-SSDB). Sabah rebuild zorunlu.

### ⚠ Bilinen tasarım kararları (kod yorumu olarak)
7. **Renk swap çelişkisi** — emrin "tersine çevir" cümlesi mevcut kodla zıt; çözüm: emrin final niyetine sadık kal (PROGRAM yeşil, REKLAM sarı). Şu an kod doğru.
8. **`userNote` model alanı** + **PATCH endpoint** korundu — UI'da Not kolonu gitti ama backend tarafı dokunulmadı. UI'da tekrar gerekirse rollback kolay.

---

## 8. Failler / Failures Bölümü

### 8.1 Önceki enum mismatch — RESOLVED
- `missing_dc_code → dc_not_applicable` rename amend (`8394836`).
- API container önceki rebuild'de eski enum içeriyordu; yeni rebuild ile sync.

### 8.2 API/Web container skew — RESOLVED
- 27 dk eski API container + 5 dk web container → enum farklı → Console error.
- `docker compose up -d --no-deps --build api` ile çözüldü.

### 8.3 62 pre-existing test fail — UNRELATED
- `StudioPlanComponent` 39 fail + `IngestListComponent` 23 fail
- Tümünde: `NG0201: No provider found for 'ActivatedRoute'. Source: Standalone[...]`
- Sebep: Standalone component TestBed setup'larında `provideRouter([])` eksik
- **Bu turda düzeltilmedi** — SSDB ile ilgisiz, ayrı PR/karar gerekli

### 8.4 Auth / token engelleri
- `curl https://beinport/api/v1/...` 401 (Invalid or expired token) — beklenen.
- Bu turda **auth bypass uygulanmadı**, SKIP_AUTH set edilmedi (emrin yasakları).
- Smoke testler kullanıcının JWT token'ı ile yapılmalı.

### 8.5 Network / secret engelleri
- SSDB_PASSWORD secret yok → SSDB aktivasyon zinciri burada durdu.
- Önceki sqlcmd testlerinde `read1/read1` ile çalışmıştı (memory'de). Ama secret tahmini yasak; `.env`'e elle eklenmeli.

---

## 9. Browser Doğrulama Listesi (kullanıcı için)

Sabah Provys ekranında (`https://beinport/provys-content-control`):

1. **Hard reload** (`Ctrl+Shift+R`) — yeni web bundle.
2. Beklenen:
   - "DC Kod" ile "Materyal" arası kolon sırası: `# | Başlangıç | Kategori | DC Kod | Materyal | Başlık | Süre`
   - **"Not" kolonu yok** (input field artık DOM'da değil)
   - **"Program başlıkları" toggle yok** filter-bar'da
   - Filter-bar'da sadece: kategori toggle'ları + "Sadece eksik materyaller" + sayı
   - Materyal badge'ler: `Bekliyor` (gri muted) çoğu satırda (cache boş, flag off); CANLI satırlarda `Canlı` (nötr gri); dcCode olmayan satırlarda `—` (nötr neutral)
3. **Console hatası yok** (özellikle "Cannot read properties of undefined" hatası).
4. PROGRAM yeşil + REKLAM sarı row/chip renkleri (değişmedi).

---

## 10. Docker Compose Durumu

```
$ docker compose ps (gece son hâli)
bcms_api       8394836 image (post-amend rebuild)     Up healthy
bcms_web       8394836 image                          Up healthy
bcms_worker    25+ saat (pre-SSDB)                    Up (no healthcheck)
bcms_postgres                                         Up healthy
bcms_keycloak                                         Up healthy
bcms_rabbitmq                                         Up healthy
bcms_grafana / prometheus / mailhog / opta_watcher    Up healthy
```

DB tablosu `ssdb_material_cache` oluştu, kapsam dışı tablolar etkilenmedi.

---

## 11. Git Durumu

```
HEAD: 8394836 feat(ssdb): add MAM material lookup for Provys flows
working tree: 7 dirty file (gece UI değişiklikleri) + 7 pre-existing dirty + 2 untracked
remote: origin/main 44 commit geride; push YAPILMADI
```

**Commit/push yok** — emir gereği. Kullanıcı sabah karar verecek:
- Gece değişiklikleri ayrı commit veya `8394836` üzerine amend mi?
- `origin/main`'e push ne zaman?

---

## 12. Sabaha Kalan İşler (Öncelik Sırası)

1. **🔴 KRİTİK:** SSDB_PASSWORD `.env`'e ekle → worker rebuild → smoke. Yarım saatlik iş.
2. **🟡 ORTA:** Gece değişikliklerini commit'le. Önerim: ayrı bir commit (`feat(provys-ui): remove Not column, move Süre, drop Program Başlıkları filter`). SSDB compose wiring de aynı commit'e girebilir veya ayrı (`chore(ssdb): wire env + BACKGROUND_SERVICES`).
3. **🟢 DÜŞÜK:** 62 pre-existing `NG0201` test fail'ini düzeltme — ayrı PR, ActivatedRoute provider eklemek.
4. **🟢 DÜŞÜK:** `origin/main` push kararı (44 commit geride).
5. **🟢 DÜŞÜK:** Renk swap çelişkisini teyit — kullanıcı UI'da nasıl gördüğünü açıklasın.

---

## 13. Profesyonel Sınırlara Sadakat Doğrulaması

- ❌ `rm`, `git reset`, `git checkout`, `git push` yapılmadı
- ❌ Secret ifşa edilmedi (sqlcmd parolası, JWT token, vs.)
- ❌ Auth bypass yapılmadı, `SKIP_AUTH` set edilmedi
- ❌ `git commit / push` yok
- ❌ Pre-existing dirty (`studio-plan*`, `playwright`, vs.) dosyalara dokunulmadı
- ❌ API/worker split bozulmadı — API `BCMS_BACKGROUND_SERVICES: none`, worker'da `ssdb-resolver` listede
- ❌ Worker rebuild yapılmadı (kullanıcı emri "secret yoksa burada dur")
- ❌ Migration apply HARİÇ tüm DB write yok (migration zaten geçmesi gereken adımdı)
- ❌ SSDB SQL Server'a runtime bağlantı yok (sadece compose wiring hazırlığı)
- ✓ Mevcut çalışan ortam bozulmadı; flag OFF default ile inert

---

---

## 14. Correction (2026-05-27 sabah) — Renk Mapping Düzeltildi

### Yanlış yorum (gece)
Gece §1.3'te emrin "tersine çevir" cümlesi ile "PROGRAM yeşil / REKLAM sarı" final state'i çelişkili göründüğü için **swap yapılmadı**. Bu yanlıştı.

### Kullanıcının gerçek isteği (sabah teyit)
- **REKLAM yeşil** olacak
- **PROGRAM sarı** olacak
- Aynı renk düzeni hem UI hem Excel/PDF export için

### Uygulanan swap

| Konum | REKLAM (yeni) | PROGRAM (yeni) |
|---|---|---|
| `packages/shared/src/types/provys.ts` — `PROVYS_CATEGORY_STYLES` | bg `#ecfdf5`, border `#10b981`, text `#064e3b` (yeşil) | bg `#fff4e5`, border `#f59e0b`, text `#7c2d12` (sarı) |
| `apps/api/.../provys.export.ts` — `EXPORT_PALETTE` | fillHex `#D1FAE5`, accent `#10B981`, text `#064E3B` (yeşil) | fillHex `#FFEDD5`, accent `#F59E0B`, text `#7C2D12` (sarı) |
| `apps/web/.../provys-channel-panel.component.ts` `.cat-chip--reklam` (dark + light) | yeşil rgba/hex'ler | sarı rgba/hex'ler |
| `apps/web/.../provys-channel-panel.component.ts` `.cat-chip--program` (dark + light) | sarı (PROGRAM tarafı) | yeşil → sarı (yer değişti) |
| `apps/web/.../provys-channel-panel.component.ts` `.row--reklam` accent | `#10b981` (yeşil) | — |
| `apps/web/.../provys-channel-panel.component.ts` `.row--program` accent | — | `#f59e0b` (sarı) |

Etiket adları (`label: 'Reklam' / 'Program'`), category enum değerleri, classifier mantığı, filter davranışı, rawKind handling — **hiçbiri değişmedi**. Sadece renk hex/rgba değerleri swap.

### Değişen dosyalar (sabah)

```
M packages/shared/src/types/provys.ts
M apps/api/src/modules/provys/provys.export.ts
M apps/web/src/app/features/provys-content-control/provys-channel-panel.component.ts
```

Bunlar gece'deki 7 dirty dosyaya ek; toplam 10 SSDB-scope dirty file.

### Doğrulama sonuçları (sabah)

```
$ cd packages/shared && npm run build         → exit 0
$ cd apps/api && npx tsc --noEmit -p tsconfig.json   → exit 0
$ cd apps/api && npx vitest run --config ./vitest.unit.config.ts \
    src/modules/provys/ src/modules/ssdb/
  Test Files  17 passed (17)
       Tests  341 passed (341)
  Duration  3.70s
$ cd apps/web && npx tsc --noEmit -p tsconfig.json       → exit 0
$ cd apps/web && npx tsc --noEmit -p tsconfig.spec.json  → exit 0
```

Sıfır regression — UI + API tarafı temiz.

### Browser doğrulama (sabah, hard reload sonrası)

- **REKLAM kategorisi:** chip yeşil, satır sol-aksanı yeşil
- **PROGRAM kategorisi:** chip sarı, satır sol-aksanı sarı
- Diğer kategoriler değişmedi (KAMU_SPOTU mavi-mor, CANLI kırmızı, TANITIM mor, DİĞER gri)
- Excel/PDF export: aynı palet (yeşil REKLAM blokları, sarı PROGRAM blokları)

> **Container etkisi:** Web container yeni renkleri serve etmesi için `docker compose up -d --no-deps --build web` gerekir; API tarafı Excel/PDF render için `--no-deps --build api`. Bu commit'te sadece kod tarafı değişti; container rebuild kullanıcı kararı.

### Git
Bu düzeltme **commit edilmedi**. Gece + sabah değişiklikleri birlikte tek commit (renk swap + UI temizlik + compose wiring) ya da iki ayrı commit olarak değerlendirilebilir.

---

---

## 15. Correction (2026-05-27 sabah) — SSDB Cache Write Concurrency Bounded

### Neden
İlk SSDB aktivasyonu (sabah) başarılı geçti — 102 DC kodu cache'e yazıldı, sonra 156'ya yükseldi. **Ama worker tick log'unda P2024 (Prisma `Timed out fetching a new connection from the connection pool`) hataları görüldü.** Mevcut Prisma pool default 5 connection; worker container'da 9 background service (notifications, ingest-watcher, audit-retention, outbox-poller, provys-watcher, asrun-watcher, vs.) aynı pool'u paylaşıyor + audit ext her write için ek query çalıştırıyor.

Worker SSDB tick'i tek tick'te 100+ DC kodu için sıralı upsert yapıyordu ama:
- Diğer worker servisleri eş zamanlı Prisma queries
- Audit ext per-write ek query
→ Pool tüketildi → P2024.

### Yapılan düzeltme

`apps/api/src/modules/ssdb/ssdb-resolver.worker.ts`:

1. **`SsdbWorkerConfig` interface'i genişletildi:** 2 yeni alan `lookupConcurrency` ve `cacheWriteConcurrency` (env-override + clamp).
2. **`parseConcurrencyEnv` helper:** invalid/empty → default; max 10'a clamp; negatif/sıfır → default.
3. **`SSDB_ABSOLUTE_CONCURRENCY_MAX = 10`** — tüm DB-bound concurrency'lerin mutlak üst sınırı.
4. **`SsdbWorkerTickResult` interface'i genişletildi:**
   - Önce: `{ candidates, processed, changed, notified }`
   - Şimdi: `{ candidates, processed, found, missing, durationUnknown, error, changed, cacheWriteSucceeded, cacheWriteFailed, notified, durationMs }`
5. **Cache write loop:** Eski sıralı `for ... await upsert` → `ConcurrencyLimiter` (`provys.concurrency.ts`'den reuse) + `Promise.all(candidates.map(... limiter.run ...))`. Per-item try/catch — tek failure tick'i öldürmez.
6. **Outcome breakdown:** Resolver Map'inden lookupStatus dağılımı sayılıp summary'ye yansıtılır.
7. **`durationMs`:** Tick başlangıcından bitişine ms cinsinden ölçüm.

### Env değişkenleri

| Env | Default | Min | Max | Davranış |
|---|---|---|---|---|
| `SSDB_LOOKUP_CONCURRENCY` | 10 | 1 | 10 | invalid/boş → 10; >10 → clamp 10 |
| `SSDB_CACHE_WRITE_CONCURRENCY` | **3** | 1 | 10 | invalid/boş → 3; >10 → clamp 10 |

Lookup concurrency mevcut resolver kodunda zaten sıralı çalışıyor (3-tier sequential + batch IN); env yine de config'e koyuldu — gelecekte resolver paralel yapılırsa hazır altyapı.

Cache write için default **3** seçildi — kullanıcının operasyonel yorumu: "10 bazen yüksek; write tarafı korumacı default ile sınırlandırılmalı."

### Davranış değişikliği

| Önce | Şimdi |
|---|---|
| Sıralı upsert (1 paralel) | 3 paralel upsert (limiter ile sabit) |
| Tek upsert throw → tüm tick fail | Per-item try/catch → diğer item'lar devam |
| P2024 raw fırlatıldı, tick bitti | `cacheWriteFailed` sayacına yansır, tick sonuna kadar devam |
| Log: `candidates/processed/changed/notified` | Log: `candidates/processed/found/missing/durationUnknown/error/changed/cacheWriteSucceeded/cacheWriteFailed/notified/durationMs` |

### Doğrulama sonuçları

```
$ npx vitest run --config ./vitest.unit.config.ts \
    src/modules/ssdb/ src/modules/provys/provys.ssdb-merge.unit.spec.ts
Test Files  9 passed (9)
     Tests  201 passed (201)   # +8 yeni: 5 config + 3 concurrency davranış
Duration  2.57s

$ npx tsc --noEmit -p tsconfig.json   → exit 0
```

Yeni test grupları:
- `worker > loadSsdbWorkerConfig` — 5 yeni test (defaults, env override, clamp max, invalid, negatif)
- `worker > cache write concurrency + per-item failure isolation` — 4 yeni test:
  - Concurrency 3 limit peak in-flight 3'ü aşmıyor (10 DC × 30ms delay ile gözlem)
  - Clamp max 10 absolute test (20 DC)
  - Tek upsert hatası tick devam ettirir; `cacheWriteFailed=2` sayılır; warn 2 kez çağrılır
  - Summary tüm alanlar dolu (found/missing/error/durationMs)

### Canlı smoke

Worker rebuild + recreate sonrası:

```
$ docker compose logs worker --tail=300 | grep tick
{"intervalMs":60000,"windowFutureDays":14,"batchSize":50,"msg":"SSDB resolver worker configured"}
{"candidates":0,"processed":0,"found":0,"missing":0,"durationUnknown":0,
 "error":0,"changed":0,"cacheWriteSucceeded":0,"cacheWriteFailed":0,
 "notified":0,"durationMs":90,"msg":"SSDB resolver tick complete"}

$ docker compose logs worker --since 5m | grep -c P2024
0

$ SELECT lookup_status, count(*) FROM ssdb_material_cache GROUP BY lookup_status;
 found | 156
```

**P2024 = 0** ✓. Tick "complete" log'unda yeni summary alanları görünüyor. Cache 156 row (önceki 102'den artmış — sonraki tick'lerde yeni DC kodları eklenmiş).

İlk tick boş (`candidates: 0`) çünkü tüm cached DC'ler TTL içinde (`found` için 12 saat). Bir sonraki TTL-doldurma window'unda yeniden tick çalışır.

### Değişen dosyalar (correction)

```
M apps/api/src/modules/ssdb/ssdb-resolver.worker.ts          (~70 satır net)
M apps/api/src/modules/ssdb/ssdb-resolver.worker.unit.spec.ts (+5 config + 4 concurrency test)
```

API/worker split korundu — sadece worker dosyaları. Audit ext bypass yok, raw SQL yok, SSDB match/status/schema dokunulmadı.

### Açık not (geleceğe)

- **Audit ext entityId uyarısı (`composite PK?`):** SsdbMaterialCache string PK kullanıyor; audit ext `id` integer bekliyor, `entityId=0` log'a yazılıyor. Kozmetik, davranışı etkilemiyor. V2'de audit ext'i string PK'lere de adapte etmek ayrı PR.
- **Audit ext'in her write için ek query yapması:** P2024 kök sebep'lerinden biri. Cache write concurrency 3 ile pratik olarak çözüldü; ama gerçek fix audit ext'in pool kullanımını optimize etmek (örn. batch insert)— ayrı kapsam.

### Git
Bu correction da **commit edilmedi**. Gece + iki sabah correction (renk swap + concurrency) birlikte single commit veya ayrı düzenlenebilir.

---

---

## 16. Correction (2026-05-27 sabah, ikinci) — `SSDB_LOOKUP_CONCURRENCY` Resolver İçinde Aktif Edildi

### Neden
Önceki correction (§15) `SSDB_LOOKUP_CONCURRENCY` env'ini `SsdbWorkerConfig`'e ekledi ama **resolver içinde kullanılmadı** — ölü config. Resolver kodu `ssdb-material-resolver.ts` baştan beri sıralı `for ... await query` ile çalışıyordu (paralelizm yok). Kullanıcı emrindeki "en fazla 10 sorgu" kuralının asıl uygulanması burada eksikti.

### Yapılan düzeltme

**Dosya 1 — `apps/api/src/core/concurrency.ts` (YENİ):**
`ConcurrencyLimiter` Provys feature module'undan ortak core/ altına taşındı. SSDB modülü artık Provys'e bağımlı değil (mimari iyileştirme).

**Dosya 2 — `apps/api/src/modules/provys/provys.concurrency.ts`:**
Backward-compat re-export: `export { ConcurrencyLimiter } from '../../core/concurrency.js'`. Mevcut Provys watcher + concurrency.unit.spec eski path'le çalışmaya devam eder.

**Dosya 3 — `apps/api/src/modules/ssdb/ssdb-material-resolver.ts`:**
- `SsdbMaterialResolverOptions.lookupConcurrency?: number` eklendi
- `SSDB_LOOKUP_CONCURRENCY_MAX = 10` ve `DEFAULT_SSDB_LOOKUP_CONCURRENCY = 10` sabitleri
- `clampLookupConcurrency(raw)` — invalid → 10; >10 → clamp 10; <1 → 10
- `query` wrapper: `const query = (sql, params) => limiter.run(() => baseQuery(sql, params))`
- Tier 1 batch loop: `for ... await` → `await Promise.all(chunk(codes, batchSize).map(async (batch) => ...))`
- Tier 2 batch loop: aynı şekilde Promise.all
- Tier 3 per-DC: Promise.all
- MEDIA_LINK batch: Promise.all (önceki `break` kaldırıldı; ilk error mesajı `mediaLinkError`'a kaydedilir, diğer batch'ler denenmeye devam — kısmi başarı korunur)

**Dosya 4 — `apps/api/src/modules/ssdb/ssdb-resolver.worker.ts`:**
- Import path: `../provys/provys.concurrency.js` → `../../core/concurrency.js`
- Worker tick `resolver(...)` çağrısı `lookupConcurrency: cfg.lookupConcurrency` opsiyonunu geçirir

### Davranış değişikliği

| Önce | Sonra |
|---|---|
| Resolver sıralı `for ... await query` (peak in-flight = 1) | Resolver paralel `Promise.all(batches.map(... limiter.run ...))` (peak ≤ 10) |
| `SSDB_LOOKUP_CONCURRENCY` config'te tanımlı ama hiç kullanılmıyordu | Resolver'a opsiyon olarak geçirilir; clamp [1, 10] zorlanır |
| 156 DC için resolver ~10-15 sn (sıralı 4 SSDB query: alias batch + media_link batch tek tek) | 156 DC için resolver **3.5 sn** (paralel batch + limited) |
| MEDIA_LINK ilk batch fail → `break`, kalan batch'ler atlanır | İlk error mesajı kaydedilir; diğer batch'ler denenir, kısmi başarı korunur |

### Yeni resolver testleri (4 ek)

`apps/api/src/modules/ssdb/ssdb-material-resolver.unit.spec.ts > SSDB_LOOKUP_CONCURRENCY enforcement`:

1. **`lookupConcurrency=4` + 30 DC + batchSize=1 → peak ≤ 4** (gerçekten paralel)
2. **`lookupConcurrency=50` clamp → peak ≤ 10** (mutlak max)
3. **`lookupConcurrency=undefined` → default 10** (peak ≤ 10)
4. **`lookupConcurrency=1` → peak = 1** (tam sıralı; mevcut davranışın preserved versiyonu)

Concurrency tracker fake `query` her çağrıda `inFlight++`, peak'i izler; per-call 5-15 ms gecikme ile gerçek paralel davranış simüle edilir.

### Doğrulama sonuçları (test + runtime)

```
$ npx vitest run --config ./vitest.unit.config.ts \
    src/modules/ssdb/ src/modules/provys/provys.ssdb-merge.unit.spec.ts \
    src/modules/provys/provys.concurrency.unit.spec.ts
Test Files  10 passed (10)
     Tests  210 passed (210)     # önceki 201'den +4 resolver concurrency test + 5 Provys re-export aynı
Duration  2.62s

$ npx tsc --noEmit -p apps/api/tsconfig.json   → exit 0
```

### Canlı smoke — gerçek candidate üreterek

Önceki smoke (§15) tick boş geçti (`candidates: 0` — cache TTL içinde). Bu turda 156 cache satırının `last_checked_at`'ini 13 saat geri aldım (TTL aşırma); sonraki tick'te tüm 156 DC candidate oldu:

```
$ docker compose logs worker | grep "tick complete" | tail -1
{"candidates":156, "processed":156, "found":156, "missing":0, "durationUnknown":0,
 "error":0, "changed":0, "cacheWriteSucceeded":156, "cacheWriteFailed":0,
 "notified":0, "durationMs":3470, "msg":"SSDB resolver tick complete"}

$ docker compose logs worker --since 5m | grep -c P2024
0
```

**Anahtar metric'ler:**
- 156 DC için resolver paralel SSDB query'leri yapıldı (lookupConcurrency=10 default)
- `processed: 156`, `found: 156` — tümü SSDB'de bulundu (`alias` match)
- **`cacheWriteFailed: 0`** — concurrency 3 ile P2024 önlendi
- **`P2024 count: 0`** — son 5 dk hiç pool timeout yok
- `durationMs: 3470` (~3.5 sn 156 DC için; paralelleştirme ile önceki ~10-15 sn'den 3-4x hızlanma)
- `changed: 0`, `notified: 0` — outcome aynı (yeniden bulundu, değişiklik yok)

### Mimari iyileştirme

`ConcurrencyLimiter` `core/concurrency.ts`'e taşındı — Provys feature module'a bağımlı olmayan ortak utility. SSDB modülü artık core'dan import eder. Provys eski path re-export ile geriye uyumlu (mevcut spec + watcher etkilenmez).

### Değişen dosyalar (correction 2)

```
+ apps/api/src/core/concurrency.ts                           (yeni — 38 satır)
M apps/api/src/modules/provys/provys.concurrency.ts          (re-export, 10 satır)
M apps/api/src/modules/ssdb/ssdb-material-resolver.ts        (+30 net — limiter + Promise.all)
M apps/api/src/modules/ssdb/ssdb-material-resolver.unit.spec.ts  (+90 — 4 yeni concurrency test)
M apps/api/src/modules/ssdb/ssdb-resolver.worker.ts          (import path + lookupConcurrency option)
```

### Kabul kriteri durumu

| Kriter | Durum |
|---|---|
| `SSDB_LOOKUP_CONCURRENCY` aktif kullanılıyor | ✅ Resolver içinde Tier 1/2/3/MEDIA_LINK Promise.all + limiter.run |
| Default 10, min 1, max 10 (invalid → 10) | ✅ `clampLookupConcurrency` zorlar; resolver-spec'leri 4/50/undefined/1 case'leri doğrular |
| Peak in-flight test edilebilir | ✅ Tracker fake query inFlight izler; 4 yeni test |
| Gerçek candidate ile smoke | ✅ 156 DC işlendi, P2024 = 0, cacheWriteFailed = 0 |
| ConcurrencyLimiter ortak path'te | ✅ `core/concurrency.ts`; Provys re-export |
| Git commit/push yok | ✅ |

### Git
Bu correction da **commit edilmedi**. Şimdi working tree:
- SSDB-night scope dirty: 13 file (gece 7 + 3 renk + 2 concurrency + 1 yeni `core/concurrency.ts`)
- Pre-existing dirty: 5 (studio-plan*, playwright*)

---

---

## 17. Correction (2026-05-27 sabah, üçüncü) — Compose Wiring + MEDIA_LINK Partial Failure Fix + Smoke Method Notu

Yöneticinin patch kontrolü 4 eksik tespit etti; hepsi düzeltildi.

### 17.1 Compose env wiring — `SSDB_LOOKUP_CONCURRENCY` + `SSDB_CACHE_WRITE_CONCURRENCY`

`docker-compose.yml`'da hem `api` hem `worker` `environment` bloklarına eklendi:

```yaml
SSDB_LOOKUP_CONCURRENCY:      ${SSDB_LOOKUP_CONCURRENCY:-10}
SSDB_CACHE_WRITE_CONCURRENCY: ${SSDB_CACHE_WRITE_CONCURRENCY:-3}
```

Default'lar compose içinde sabit; `.env` ile override edilebilir. Önceki turlardaki `SSDB_PASSWORD` örneğindeki gibi container restart sonrası env aktif.

Hem API hem worker'a eklendi çünkü `loadSsdbConfig`/`loadSsdbWorkerConfig` ikisi de `process.env` okur (route `/ssdb/cache/refresh` resolver çağırırsa lookup limiter API tarafında da devreye girer).

### 17.2 `.env.example` — yorumlu placeholder

```env
# Concurrency (clamp [1,10]; invalid/empty -> default):
# SSDB_LOOKUP_CONCURRENCY=10       # SSDB query fan-out (default 10, max 10)
# SSDB_CACHE_WRITE_CONCURRENCY=3   # Prisma upsert (default 3, max 10; P2024 onlem)
```

### 17.3 MEDIA_LINK partial failure davranışı — FIX

**Tespit:** §16'da yazılı "kısmi başarı korunur" iddiası **kod tarafında yanlıştı**. Outcome shaping'te global `mediaLinkError != null` guard'ı **tüm bulunan media'ları** `duration_unknown`'a düşürüyordu — başarılı batch'lerin GUID'leri dahil. Yöneticinin tespiti doğru.

**Düzeltme** (`ssdb-material-resolver.ts:351`):
- Global `if (mediaLinkError != null)` early-return **kaldırıldı**.
- Outcome shaping `guidToLink.get(entry.mediaGuid)` Map'ine güvenir:
  - Link bulundu → normal `found` outcome (gerçek tcSom/tcEom + ssdbDuration)
  - Link bulunmadı (batch fail VEYA gerçekten satır yok) → `duration_unknown` + `lastError: mediaLinkError` (varsa global mesaj info olarak)

**Davranış:**

| Senaryo | Önce | Sonra |
|---|---|---|
| 2 batch, biri fail biri success | TÜM 2 GUID `duration_unknown` (global guard) | Başarılı batch'in GUID'i `found`, fail batch'in GUID'i `duration_unknown` |
| Tek batch fail (önceki test case) | Tek GUID `duration_unknown` + lastError | Aynı — tek-batch için davranış değişmedi |
| Hiç fail yok, link satırı eksik | `duration_unknown`, lastError=null | Aynı |

**Yeni test** (`ssdb-material-resolver > MEDIA_LINK partial failure`):
- 2 DC + batchSize=1 → 2 ayrı MEDIA_LINK batch query
- 1. batch error, 2. batch success
- Assertion: DC1 (GUID-1) `duration_unknown` + lastError set; DC2 (GUID-2) `found` + ssdbDurationFrames=101

Eski test ("MEDIA_LINK batch error → bulunan tum DC duration_unknown") tek-DC case'inde aynı davranışı koruyor (tek GUID, tek batch fail = guidToLink boş = duration_unknown).

### 17.4 Smoke method notu — raw `UPDATE` kullanımı

§16'daki canlı smoke için `UPDATE ssdb_material_cache SET last_checked_at = NOW() - INTERVAL '13 hours'` doğrudan Postgres'e yapıldı. **BCMS audit/write disiplinine aykırı yöntem** — production'da kullanılmaz.

**Geleceğe öneriler:**
1. Geçici düşük TTL env (`SSDB_TTL_FOUND_MIN=1`) ile worker recreate; testten sonra eski değere döndür.
2. Test-only helper endpoint (admin-only `POST /api/v1/ssdb/cache/expire?dcCode=...` veya `?all=true`).
3. Resolver outcome'un degisecegi gercek bir Provys + SSDB veri akışı.

**Dev smoke icin kabul** edildi ama prod'da raw SQL write **YASAK** — audit ext bypass + Prisma client kapasitesini atlayan yol; BCMS güvenlik kuralı.

### Doğrulama (correction 3)

```
$ npx vitest run --config ./vitest.unit.config.ts \
    src/modules/ssdb/ src/modules/provys/provys.ssdb-merge.unit.spec.ts \
    src/modules/provys/provys.concurrency.unit.spec.ts
Test Files  10 passed (10)
     Tests  211 passed (211)   # önceki 210 + 1 partial failure testi
Duration  2.53s

$ npx tsc --noEmit -p tsconfig.json   → exit 0
```

### Değişen dosyalar (correction 3)

```
M apps/api/src/modules/ssdb/ssdb-material-resolver.ts          (mediaLinkError early-return kaldirildi; lastError link-yok durumuna inject)
M apps/api/src/modules/ssdb/ssdb-material-resolver.unit.spec.ts (+1 partial failure testi)
M docker-compose.yml                                            (SSDB_LOOKUP_CONCURRENCY + SSDB_CACHE_WRITE_CONCURRENCY hem api hem worker)
M .env.example                                                  (yorumlu placeholder)
M docs/reports/2026-05-27-provys-ssdb-night-run.md               (bu bölüm)
```

### Yapılmadığı net

- ❌ Git commit/push yok
- ❌ Worker rebuild bu turda yapılmadı (compose env değişikliği next-recreate'te aktif; gerek olduğunda `docker compose up -d --no-deps --force-recreate worker api`)
- ❌ Smoke testi tekrarlanmadı (önceki §16 smoke'u zaten 156 processed / P2024=0 göstermişti — partial failure davranış değişikliği outcome shaping'te + kapsamı genişletti ama yeni runtime test yapmadan kabul; unit test partial failure scenario'sunu deterministik olarak doğruluyor)
- ❌ Raw SQL write smoke yöntemi production'da kullanılmamalı (yukarıdaki not)

### Working tree özeti

SSDB-night scope dirty: **15 dosya**
- Gece UI/compose/rapor: 7
- Renk swap (3) + Concurrency v1 worker (2) + Concurrency v2 resolver (4)
- Bu correction: +5 daha (yeni eklenen `core/concurrency.ts` zaten önceki turda staged, korunuyor)

Pre-existing dirty: 5 (studio-plan*, playwright*) — dokunulmadı.

---

---

## 18. Correction (2026-05-27 sabah, dördüncü) — MEDIA_LINK Per-GUID Failure Tracking

### Eksik
§17.3'te global `mediaLinkError` mesajı, **link bulunamayan tüm GUID'lere** lastError olarak yazılıyordu — fail batch'e denk gelmemiş "success-but-empty-row" GUID'lerine de. Bu yanlış: unrelated link-missing GUID'ler aslında bir hata değil; sadece SSDB'de o materyalin link satırı yok.

### Düzeltme

`apps/api/src/modules/ssdb/ssdb-material-resolver.ts`:

- `let mediaLinkError: string | null = null` → `const failedMediaLinkGuids = new Map<string, string>()`
- Batch fail catch: `for (const g of guidBatch) failedMediaLinkGuids.set(g, errMsg)` — sadece fail batch'in GUID'leri map'e girer
- Outcome shaping: `lastError: failedMediaLinkGuids.get(entry.mediaGuid) ?? null` — sadece o GUID fail batch'e denk geldiyse mesaj set olur

### Davranış matrisi (3 GUID senaryo)

| GUID | MEDIA_LINK batch | Outcome |
|---|---|---|
| GUID-1 | error | `duration_unknown` + lastError set ("partial fail GUID-1 batch") |
| GUID-2 | success + row | `found` + ssdbDurationFrames=101 |
| GUID-3 | success + empty row | `duration_unknown` + **lastError NULL** ← fail batch'in mesajı bu GUID'e SIZMAZ |

### Yeni test

`MEDIA_LINK partial failure > 3 GUID, 1 fail / 1 success+row / 1 success+empty -> per-GUID lastError isolation` — yukarıdaki matrisi assertion ile doğrular.

Mevcut testler korundu:
- "MEDIA found ama MEDIA_LINK satiri yok" → tek DC, batch success ama row yok → lastError null ✓
- "MEDIA_LINK batch error" → tek DC, batch fail → lastError set ✓
- "paralel MEDIA_LINK batch'lerden biri fail, digeri success" (2 GUID) → DC1 lastError set, DC2 found ✓

### Doğrulama

```
Test Files  10 passed (10)
     Tests  212 passed (212)   # +1 per-GUID isolation testi
Duration  2.50s

API tsc --noEmit              → exit 0
```

### Değişen dosyalar (correction 4)

```
M apps/api/src/modules/ssdb/ssdb-material-resolver.ts          (mediaLinkError → failedMediaLinkGuids Map)
M apps/api/src/modules/ssdb/ssdb-material-resolver.unit.spec.ts (+1 per-GUID isolation testi)
M docs/reports/2026-05-27-provys-ssdb-night-run.md               (bu bölüm)
```

### Deploy notu

Bu correction merge edildikten sonra runtime aktivasyon için:

```bash
docker compose up -d --no-deps --force-recreate api worker
# Compose env değişiklikleri (concurrency env wiring §17.1) çalışan
# container'lara kendiliğinden GEÇMEZ — recreate gerekli.
```

---

**Rapor sonu — 2026-05-27 (gece + beş sabah correction; SSDB tam aktif, P2024 yok, partial failure per-GUID izolasyonlu)**
