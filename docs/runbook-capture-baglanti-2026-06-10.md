# RUNBOOK — Ingest ↔ Avid Capture Web Service BAĞLANTI Günü

> Tarih: 2026-06-11 (yarın) · Hedef: **YALNIZ BAĞLANTI (read-only)**
> ⛔ **KESİN EMİR: Capture CANLI. Hiçbir yazma (create/modify/delete recording) YOK.
> Hiçbir kontrolsüz test YOK. Yazma + test, ayrı ve müsait bir zamanda yapılacak.**

---

## 0. Güvenlik Sözleşmesi (her adımdan önce hatırla)

| # | Kural |
|---|---|
| 1 | Capture'a giden HER çağrı **yalnız okuma** olacak: TCP connect, WSDL GET, (onaylanırsa) listeleme/sorgu operasyonu. |
| 2 | **Yazma metodları koda HİÇ yazılmayacak** (guard'lı bile değil — kod yoksa kaza da yok). Yazma, ayrı PR ile test gününde gelir. |
| 3 | Her canlı çağrı **tek tek, Osman'ın sözlü onayıyla**; otomatik/periyodik hiçbir şey Capture'a bağlanmaz (worker'a entegrasyon YOK). |
| 4 | Çağrı başına **kısa timeout (10 sn), tek deneme, retry YOK** — canlı sistemi yormayız. |
| 5 | Capture operatörü/ekranında en ufak uyarı, beklenmeyen davranış → **DUR**, durum tespiti, devam kararı Osman'ın. |
| 6 | Tüm çağrılar ve yanıt özetleri loglanır (sır loglanmaz). |

## 1. Ön Koşullar — Osman'dan yarın gerekenler

- [ ] Capture **Web Service kuruldu mu, hangi host'ta?** (Capture sunucusu mu, ayrı sunucu mu — IP/hostname)
- [ ] **Lisans** uygulandı mı? (boot-loop riski: lisanssız kurulumda servis döngüye girer — kurulumu Avid/IT yaptıysa teyit yeter)
- [ ] Port **8080** mi, değiştirildi mi? (`Workgroup.Properties → com.avid.ingest.sdk.webservice.Port`)
- [ ] BCMS sunucusundan o host:port'a ağ izni (firewall) açık mı?
- [ ] (Varsa) Avid'in örnek istemcisi `TestCaptureWebClient` / SDK dokümanı elimizde mi? (WSDL yorumlamada hızlandırır)

## 2. Faz A — Keşif (BCMS koduna dokunmadan, salt okuma)

> Bu fazda hiçbir kod deploy edilmez; sadece komut satırından tanılama.

- [ ] **A1 — TCP erişim**: `host:8080`'e TCP connect (node net.connect, 6 sn timeout). Sadece soket açılır-kapanır; Capture'a istek gitmez.
- [ ] **A2 — WSDL çek** *(Osman onayı ile)*: `GET http://<host>:8080/ScheduleClient?wsdl` → dosyaya kaydet. Bu, şema okumadır; kayıt verisine dokunmaz.
- [ ] **A3 — WSDL analizi (offline)**: operasyon envanteri çıkar; her operasyonu sınıfla:
  - 🟢 READ (get/list/query/subscribe-notification) → aday
  - 🔴 WRITE (create/modify/delete/update recording) → **bu projede yarın YASAK, koda da girmeyecek**
- [ ] **A4 — (opsiyonel, ayrı onay)**: WSDL'den net biçimde zararsız olduğu görülen TEK bir READ operasyonu (ör. kanal/recording listesi) elle, tek sefer çağrılır. Amaç: auth/format doğrulama. Onay yoksa atlanır — bağlantı kanıtı için A2 yeterlidir.

**Faz A çıktısı:** "Bağlantı VAR/YOK + operasyon envanteri (read/write sınıflı) + auth gereksinimi" raporu.

## 3. Faz B — BCMS kod iskeleti (read-only, deploy ayrı onayla)

Yeni `apps/api/src/modules/capture/` — **yalnız şu dosyalar**:

| Dosya | İçerik | Yazma? |
|---|---|---|
| `capture.config.ts` | env: `CAPTURE_WS_URL`, `CAPTURE_WS_TIMEOUT_MS` (default 10000), `CAPTURE_WS_ENABLED` (**default `false`**) | — |
| `capture.soap.ts` | `avid.soap.ts` paterni: SOAP POST + timeout + tek deneme. **Yalnız READ gövdeleri.** | ❌ yazma gövdesi YOK |
| `capture.client.ts` | `fetchWsdl()`, `ping()`, (A4 onaylandıysa) `listX()` — hepsi read | ❌ create/modify/delete fonksiyonu YOK |
| `capture.routes.ts` | `GET /api/v1/capture/health` → SystemEng-only, **elle tetiklenen** bağlantı testi (WSDL fetch) | ❌ POST/PUT/DELETE endpoint YOK |

**Bilinçli olarak YOK:** worker entegrasyonu, ingest `PUT /plan/:sourceKey` kancası, `capture_recordings` tablosu/migration, mock-write — bunlar yazma/test gününün işi.

Çift kilit: (1) `CAPTURE_WS_ENABLED=false` iken client URL'e hiç çıkmaz, (2) yazma kodu hiç mevcut değil.

## 4. Faz C — Kontrollü canlı doğrulama (yarın, birlikte, adım adım)

Sıra — **her maddede önce Osman'a sor, onay al, sonra çalıştır, sonucu göster**:

1. [ ] A1 TCP → sonuç raporu → onay
2. [ ] A2 WSDL → kaydet + envanter → onay
3. [ ] (İsteğe bağlı) A4 tek READ çağrısı → yanıt özeti
4. [ ] Faz B iskeleti commit (deploy edilmeden) → istenirse deploy + `GET /capture/health` ile aynı doğrulama BCMS içinden
5. [ ] Gün sonu: keşif raporu `docs/`'a; yazma/test fazının ön planı (ayrı gün) çıkarılır

## 5. DUR Kriterleri

- Capture Client/Monitor'da alarm, kanal sağlığında değişim, operatör şikâyeti
- WSDL/READ çağrısına beklenmeyen yanıt (5xx, kilitlenme, uzun gecikme)
- Servisin restart/boot-loop belirtisi
→ Anında dur; hiçbir yeniden deneme yapılmaz; durum Osman'a raporlanır.

## 6. Bağlam (önceden bilinenler)

- Endpoint: `http://<host>:8080/ScheduleClient` (SOAP, `ScheduleClientService`) — *interplay capture install.pdf* s.23
- Remote API yeteneği: "create, modify, delete recordings + notifications" — yazma kısmı bu fazda kapsam DIŞI
- Sahadaki sürüm: MediaCentral | Capture **4.0.15.281**, kayıt cihazları AirSpeed, kanal ~120/server
- BCMS hazır kalıpları: `postSoap` (avid.soap.ts:166, AbortController+timeout), tek-satır ayar tablosu paterni (`avid.settings.ts`), SystemEng-only route paterni
- Üst plan: `docs/capture-entegrasyon-plani-2026-06-09.md` (bu runbook = oradaki **Faz 0'ın canlı-güvenli versiyonu**)
