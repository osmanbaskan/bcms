# Avid IPWS Entegrasyonu — İlerleme Dökümanı

> **Amaç:** BCMS "Restore" sekmesinin (3 kademeli Avid Interplay iş akışı) gerçek
> Avid IPWS SOAP bağlantısını kurmak. Kod tamamen yazılı; tek eksik gerçek
> `AvidAdapter` implementasyonu (şu an mock).
>
> **Branch:** `feat/avid-ipws-search`
> **Plan:** `~/.claude/plans/calm-munching-pelican.md`
> **Kaynak rapor:** `IPWS-Master-Entegrasyon-Raporu-2026-05-31.md` (ayrı PoC özeti)
> **Başlangıç:** 2026-05-31

## Çalışma Kuralları (kullanıcı onaylı)
1. **Onaysız test YOK** — testler birlikte, kullanıcı onayıyla çalıştırılır.
2. **Her adımda test ederek ilerle** — küçük adımlar, her adımda dur + onay al.
3. **Silme KESİNLİKLE yasak** — dosya/kod/kayıt silinmez. Her şey ekleme/düzenleme.
4. **DB sıfırlama yasak** — migration/DROP/force-reset yok.

## Kapsam Kararları (kullanıcı onaylı)
- **Kapsam:** Yalnız **Kademe 1 (search / Assets.Search)** gerçek Avid'e bağlanır. K2 (restore) + K3 (transfer) mock'ta kalır.
- **Readiness:** `AvidAsset.online` = basit `Media Status === online` okuması (A/B/C state ayrı iterasyona ertelendi).
- **Geçiş/güvenlik:** Flag + env-only; mock default. Credentials log'da redaction.
- **Profil:** K2 için env'den tek profil (Partial) — bu PR'da sadece config alanı hazırlanır, kod yazılmaz.

---

## Adımlar

### ✅ Adım 1 — SOAP transport helper (`avid.soap.ts`)
**Durum:** TAMAMLANDI (kod yazıldı) · Test: Adım 4'te birlikte doğrulandı

**Dosya:** `apps/api/src/modules/avid/avid.soap.ts` (YENİ)

İçerik:
- `AVID_NS` — namespace sabitleri (rapor §5).
- `AvidSoapError` — `code` (IPWS Error Code veya HTTP_ERROR/TIMEOUT/SOAP_FAULT/PARSE_ERROR) + `details`.
- `escapeXml`, `serviceEndpoint(base, service)`.
- `buildEnvelope({username,password,bodyNs,bodyXml})` — **namespace tuzağı**: `UserCredentials` daima `c:`=assets/types; body `b:`=bodyNs (rapor §3).
- `postSoap(cfg, {service,bodyNs,bodyXml})` — fetch POST, `SOAPAction:""`, AbortController timeout, gövdeyi her durumda parse, `<Errors>`/`<Fault>` → throw, temizse `Envelope.Body` döner. Parser `removeNSPrefix:true` (ns-agnostik). Parola `redact()`.

### ✅ Adım 2 — `Assets.Search` → `searchByDcCode` (`avid.client.ts`)
**Durum:** TAMAMLANDI (kod yazıldı) · Test: Adım 4'te doğrulandı

**Dosya:** `apps/api/src/modules/avid/avid.client.ts` (DÜZENLE)

- `createInterplayAvidAdapter`: `searchByDcCode` artık gerçek; diğer 4 method `notImpl` throw (kademeli rollout korundu).
- `buildSearchBody` — Display Name `Contains` dcCode (USER) + Type `Equals` sequence (SYSTEM), MaxResults 50 (rapor §9.2).
- `collectAssetDescriptions` (recursive), `attributesToMap` (rapor §7.1 `<Attribute Name=>`), `extractMobId` (rapor §7.3 dedup).
- `interplaySearchByDcCode` — search → MOB-dedup (Map) → eşleme: `id`=mobid, `name`=Display Name, `online`=Media Status==online, `modifiedAt`=Modified Date, `durationFrames`=Duration(varsa). Defansif `name.includes(dcCode)` filtresi.

**Açık belirsizlikler (canlı smoke'ta netleşecek):**
1. Attribute değeri `#text`'te mi geliyor (attribute'lu element) — varsayım, gerçek XML'le teyit.
2. `Duration` formatı (frame mi `HH:MM:SS:FF` mi) belirsiz — sayıya çevrilebiliyorsa alınıyor, yoksa atlanıyor.

### ✅ Adım 3 — Config genişletme (`avid.config.ts`)
**Durum:** TAMAMLANDI (Adım 2 ile birlikte)

**Dosya:** `apps/api/src/modules/avid/avid.config.ts` (DÜZENLE)

Yeni alanlar: `searchRootUri` (default `interplay://BSVMWG/Projects/`), `workgroup` (BSVMWG), `restoreProfile` (`BeINSports - Partial Restore`, K2 hazırlığı), `restoreService` (`com.avid.dms.restore`, K2 hazırlığı). `assertAvidConfigReady` değişmedi (yeni alanlar default'lu).

### ✅ Adım 4 — Birim testler
**Durum:** TAMAMLANDI · **Test SONUCU: 23/23 GEÇTİ** (host node v20.20.2 + node:20 container, çift doğrulama)

```
✓ avid.soap.unit.spec.ts   (11 tests)
✓ avid.client.unit.spec.ts (12 tests)
Test Files  2 passed (2) · Tests 23 passed (23)
```
Komut: `npm run test:unit -- avid` (apps/api dizininde). Regresyon: `ssdb.client` (8) + `ssdb-duration` (40) de yeşil — vitest ortamı sağlam.

Dosyalar (her ikisi `*.unit.spec.ts` — network/DB yok):
- `avid.soap.unit.spec.ts` — escapeXml, serviceEndpoint, buildEnvelope namespace tuzağı (c:=assets, b:=body), postSoap (POST+text/xml+SOAPAction:"", temiz Body, `<Errors>`→throw, `<Fault>`→throw, non-2xx→HTTP_ERROR, AbortError→TIMEOUT, parola redaction).
- `avid.client.unit.spec.ts` — buildSearchBody içerik; searchByDcCode (online/offline, MOB dedup, multi-match, 0→[], Contains false-positive filtre, Media Status yok→false); kademeli rollout (search gerçek / 4 method notImpl); getAvidAdapter factory (mock vs interplay); mock regresyon.

fetch `vi.stubGlobal` ile mock; XML fixture'lar rapor §7.1/§16.2'den türetildi.

### ✅ Adım 5 — Env örnekleri + doküman
**Durum:** TAMAMLANDI

**Dosya:** `.env.example` (kök — `infra/` değil; gerçek konum). DÜZENLE.

- **Bulgu:** AVID bölümü zaten vardı (V2, 2026-05-28) ama K1 için eklediğim yeni alanlar eksikti.
- AVID bölümü baştan yazıldı: flag matrisi (mock default / gerçek koşulu), 4 zorunlu env (`AVID_INTERPLAY_URL/USER/PASSWORD/WORKSPACE`), K1 search opsiyonelleri (`AVID_SEARCH_ROOT_URI`, `AVID_WORKGROUP`, `AVID_REQUEST_TIMEOUT_MS`), K2 hazırlık (`AVID_RESTORE_PROFILE`, `AVID_RESTORE_SERVICE` — yorumlu, kullanılmıyor).
- `AVID_PASSWORD=<GENERATE_ME_avid_ipws_password>` placeholder (SSDB pattern paritesi); gerçek değer repoya GİRMEZ. Güvenlik notu (rapor §18) + DNS bypass notu (rapor §2.3) eklendi.
- **Dokunulmadı:** gerçek `.env`, `.env.bak`, `apps/api/.env` (değer içeriyorlar).

### ✅ Adım 6 — Build doğrulama
**Durum:** TAMAMLANDI · **AVID tarafı temiz**

- `npm run build` (apps/api, `rm -rf dist && tsc`) → **EXIT=0**, sıfır TS hatası (kaynak tip-doğru).
- `npm run lint` (`tsc --noEmit` + test tsconfig) → AVID kaynaklı **0 hata** (ilk koşumda 2 test-tipi hatam vardı → düzeltildi: `beforeEach` blok gövde + `as unknown as` cast).
- Interface (`AvidAdapter`/`AvidAsset`) sabit kaldığı için K2/K3 worker/service derlemesi etkilenmedi.

**⚠️ Kapsam-dışı not:** `npm run lint` toplamda EXIT=2 — kalan **6 hata `provys.*` spec dosyalarında** (`provys.parser/service/snapshot.unit.spec.ts`). Bunlar **önceden var** (main ile birebir aynı, `git diff main` boş — bu dalda provys'e dokunulmadı). Benim değişikliğimle ilgisiz; ayrı bir temizlik işi. **Build (sadece src) EXIT=0** olduğu için runtime/derleme etkilenmiyor; bu hatalar yalnız test tsconfig katılığından.

### ✅ Adım 7 — Mock regresyon ✅ + canlı smoke ✅
**Durum:** TAMAMLANDI — canlı IPWS search çalışıyor (DC00036170 → 1 asset)

**Mock regresyon (ağ yok) — SONUÇ: avid 23/23 GEÇTİ (EXIT=0)**
```
npm run test:unit -- avid
✓ avid.soap.unit.spec.ts   (11)
✓ avid.client.unit.spec.ts (12)
Test Files 2 passed · Tests 23 passed
```
**ÖNEMLİ GERÇEK:** `search/restore/transfer` modüllerinin **hiç birim test dosyası YOK**
(yalnız `dto/routes/service/worker.ts`; `.spec.ts` yok). Yani bu modüller için koşulacak
unit regresyon mevcut değil. Mock davranışı `avid.client.unit.spec.ts` içinde dolaylı
doğrulanıyor (getAvidAdapter mockMode → mock adapter, requestRestore avidJobId döndürür).
- **Kanıt zinciri:** K1 eklemesi `AvidAdapter`/`AvidAsset` interface'ini DEĞİŞTİRMEDİ
  (Adım 6 build EXIT=0) → worker/service'lerin adapter'ı çağırma sözleşmesi aynı →
  mock akışı davranışsal olarak korunuyor.
- Gerçek uçtan-uca mock regresyon ancak çalışan API + restore sekmesi (Playwright veya
  manuel) ile görülebilir. İstenirse bu yapılabilir (ağ YOK, sadece mock).

**Canlı smoke (gerçek IPWS) — ✅ BAŞARILI (2026-05-31, DC00036170)**

Script: `apps/api/scripts/avid-search-smoke.ts` (standalone, tek DC, read-only, DB'ye
dokunmaz). PoC kullanıcısı (Presenter01) inline env ile; IP bypass
(`http://172.26.33.87/services`, DNS `.local` çözülmüyor — rapor §2.3). Credentials
repoya/.env'e YAZILMADI; smoke parolayı maskeli basıyor.

Sonuç:
```
HTTP 200, 3210 byte
Sonuç: 1 asset
 • id: 060a2b340101010501010f1013-...-28eb  (mobid)
   name: DC00036170_KOREN_MANISA_37H_1D
   online: true            (Media Status=online → doğru)
   modifiedAt: 2026-04-27T16:01:16.000+0300
```

**Gerçek XML şekli (canlı doğrulandı — rapor §7.1 ile UYUMLU):**
- `<SearchResponse><Results><AssetDescription>` — InterplayURI **child element** ✓
- `<Attribute Name="..." Group="...">` — **büyük harf** Name/Group ✓
- → Kod ilk denemede doğru parse etti; **parse düzeltmesine gerek olmadı**.

**Netleşen belirsizlikler:**
1. `#text` değer okuma → ✓ doğru. `Name=`/`Group=` büyük harf → ✓.
2. Aynı mobid **2 kez** döndü (Moniker farklı, ingest+broadcast path) → MOB-dedup
   doğru çalıştı, tek asset. (rapor §7.3 ✓)
3. **`Duration` = `00:49:14:00` (TIMECODE), frame DEĞİL.** Kodum `Number("00:49:14:00")`
   = NaN → `durationFrames` atlanıyor (defansif, hata yok). ⚠️ İyileştirme adayı:
   istenirse timecode→frame çevrimi eklenebilir (yanıtta `CFPS=25.00` da var).
   Şu an `durationFrames` opsiyonel + UI'da kullanılmıyor → bloklamıyor.

**⚠️ Yanlış-alarm notu (dürüstlük):** Smoke ilk denemede başardı. Sonradan, path'i bozuk
(çalışmayan) bir parse-test script'ine dayanıp hatalı "küçük harf/attribute parse bug"
teşhisi koyup düzeltme denedim; komut hatası sayesinde o edit'ler iptal oldu → kod/spec/doc
bozulmadı (grep ile teyitli). Gerçekte kod baştan doğruydu.

**Canlı smoke (gerçek Avid — ağ + credentials + operatör onayı):**
`DC00036170` ile gerçek IPWS'e search → `AWAITING_SELECTION`, `avid_assets` gerçek veriyle dolu. DNS yoksa IP (`172.26.33.87`). Açık belirsizlikler (#text, Duration) burada netleşir.

---

## Değişmeyecekler (kapsam dışı)
- K2/K3 adapter method'ları (`requestRestore`/`pollRestoreStatus`/`requestTransfer`/`pollTransferStatus`) → `notImpl` stub.
- K2/K3 worker/service/route/Prisma, `AvidAdapter`/`AvidAsset` interface, frontend, DB/migration.

## Değişiklik Günlüğü
- 2026-05-31: Döküman oluşturuldu. Adım 1-2-3 kod yazımı tamam.
- 2026-05-31: Adım 4 — birim testler yazıldı ve ÇALIŞTI → **23/23 geçti** (host v20.20.2 + node:20 container). Regresyon ssdb testleri yeşil. (Çalıştırma sırasında ilk çıktı yanlış okunup geçici "bloker" şüphesi doğmuştu; gerçekte sorun yoktu — testler ilk denemede geçti.)
- 2026-05-31: Adım 5 — `.env.example` (kök) AVID bölümü K1 için baştan yazıldı (yeni alanlar + flag matrisi + güvenlik/DNS notu). Gerçek .env dosyalarına dokunulmadı.
- 2026-05-31: Adım 6 — build EXIT=0; lint AVID tarafı temiz (2 kendi test-tipi hatam düzeltildi). Kalan 6 lint hatası provys.* spec'lerinde (önceden var, main ile aynı, kapsam dışı).
- 2026-05-31: Adım 7 (mock regresyon) — avid unit testleri **23/23 geçti**. search/restore/transfer modüllerinin birim testi YOK (yalnız avid kapsanıyor). K1 interface'i değiştirmediği için (build EXIT=0) mock akışı korunuyor. (Düzeltme: bu adımda önce hatalı "185" sonra "314" yazılmıştı — gerçekte koşan yalnız 23 avid testi; ilgili modüllerin spec'i yok.)
- 2026-05-31: Adım 7 (canlı smoke) — **DC00036170 → 1 asset, online:true, BAŞARILI.** Kod ilk denemede doğru parse etti (gerçek XML rapor §7.1 ile uyumlu: child InterplayURI + büyük harf Name). MOB-dedup çalıştı. Duration timecode geldi (frame değil) → durationFrames atlanıyor (defansif, iyileştirme adayı). Smoke script: apps/api/scripts/avid-search-smoke.ts. **K1 SEARCH ENTEGRASYONU TAMAMLANDI.** (Yanlış-alarm: çalışmayan parse-testine dayanıp geçici hatalı "bug" teşhisi koydum; edit'ler iptal oldu, kod bozulmadı.)
