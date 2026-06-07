# Avid Entegrasyon — ARA → RESTORE → TRANSFER Zinciri (Master)

**Konu:** BCMS Restore sekmesinin uçtan uca zinciri — DC kod ile arama, arşivden geri yükleme (restore) ve yayın havuzuna aktarım (transfer).
**İlk rapor:** 2026-05-31 (IPWS PoC) · **Güncelleme:** 2026-06-08
**Bu sürüm:** Zincire odaklandı. Transfer artık IPWS `SendToPlayback` ile DEĞİL, **Cloud UX / CTMS `submitSTPJob`** ile yapılıyor (2026-06-01 canlı doğrulandı). Token için **OAuth2/AD ROPC login** akışı eklendi ve gerçek cluster'a karşı canlı doğrulandı. Gereksiz/yanlış/PoC bölümleri çıkarıldı.

> **Kanıt etiketleri:** **[DOĞRULANDI]** canlı test · **[WSDL]** şemadan · **[DOKÜMAN]** Avid resmi doküman · **[V1]** mevcut basitleştirme.

---

## 0. Zincir tek bakışta

**Üç kademe, İKİ ayrı auth dünyası:**

| Kademe | İş | Teknoloji | Auth | Durum |
|---|---|---|---|---|
| **K1 ARA** | DC kod → Avid arşiv araması | IPWS **SOAP** `Assets.Search` | `UserCredentials` (kullanıcı/parola, her istekte) | ✅ süresiz çalışır |
| **K2 RESTORE** | Asset'i arşivden Interplay'e getir | IPWS **SOAP** `Jobs.SubmitJobUsingProfile` + `GetJobStatus` | `UserCredentials` | ✅ süresiz çalışır |
| **K3 TRANSFER** | Asset'i yayın havuzuna gönder | Cloud UX **CTMS** `submitSTPJob` (REST) | **`avidAccessToken`** (login ile üretilir) | ✅ çalışır, token kalıcı çözümü §3.2 |

**Kritik fark:** K1/K2 her SOAP isteğinde kullanıcı/parola gönderir → token yok, süresiz. K3 token tabanlı → token yönetimi (§3.2) zincirin tek kırılgan noktasıydı; kalıcı çözüm = **ROPC login ile otomatik token üretimi** (uygulandı).

```
Arşivde (offline)
   │  K1  Assets.Search(DC kod)            → asset (mobId)            [DOĞRULANDI]
   │  K2  Jobs.SubmitJobUsingProfile       → restore job             [DOĞRULANDI]
   │      Jobs.GetJobStatus (Completed)    → media online            [DOĞRULANDI]
   ▼
Online (Interplay'de)
   │  K3  CTMS submitSTPJob (avidAccessToken)                        [DOĞRULANDI 2026-06-01]
   │      └─ CDS Service: mixdown + encode + SendToPlayback'i KENDİ orkestra eder
   ▼
Yayın havuzu (MCR / PCR ... — Avid DIŞI)
```

> **Önemli sadeleşme:** CTMS `submitSTPJob` arkasındaki **CDS Service mixdown + encode + playback'i kendi yapar.** Bu yüzden eski raporun "readiness (A/B/C) / `.transfer` companion / `CheckSequenceIsReadyForXfer` / IPWS `SendToPlayback`" aşamalarına **gerek yok** — zincirden çıkarıldı.

---

## 1. Bağlantı + kimlik (hızlı kart)

> ⚠️ Gerçek kimlik bilgileri **kod/env/DB'de** (`avid_settings`), bu belgede değil. Aşağıdakiler örnek/placeholder.

### IPWS (K1 + K2) — SOAP
| Parametre | Değer |
|---|---|
| IPWS Base URL | `http://{ipws-host}/services` |
| Workgroup | `BSVMWG` · URI prefix `interplay://BSVMWG/` |
| Kullanıcı / Parola | servis hesabı (domain prefix YOK) — `AVID_USER` / `AVID_PASSWORD` |
| Auth | SOAP Header `UserCredentials` (token/Basic YOK) |
| Endpoint'ler | `/services/Assets`, `/services/Jobs` (K1/K2 için bu ikisi yeter) |

### Cloud UX (K3) — CTMS / REST
| Parametre | Değer |
|---|---|
| Cloud UX Base URL | `https://{cloudux-host}` — `AVID_CLOUDUX_URL` |
| Realm (PAM systemID) | `AVID_CLOUDUX_REALM` |
| STP device / profile | `AVID_STP_DEVICE` / `AVID_STP_PROFILE` (örn. MCR) |
| Auth | `avidAccessToken` (Cookie) — **ROPC login ile üretilir** (§3.2) |
| Self-signed TLS | `AVID_CLOUDUX_INSECURE_TLS` (sadece bu client'ta gevşetilir) |

---

## 2. K1 + K2 ortak — SOAP çağrı mekaniği

Hiçbir SOAP kütüphanesi gerekmez; düz HTTP POST + XML.

- Metot `POST`, `Content-Type: text/xml; charset=utf-8`, `SOAPAction: ""` (boş — [DOĞRULANDI]).
- **İş hataları HTTP 200** içinde `<Errors><Error Code="...">` döner; bazı protokol hataları **HTTP 500 + `<Fault>`** → gövdeyi her durumda oku.
- **Parser ns-agnostik:** element `localname`'ine bak (`tag.split("}")[-1]`); Avid prefix/ns varyasyonu döndürebilir.

> **🔑 NAMESPACE TUZAĞI — [DOĞRULANDI].** `UserCredentials` **HER ZAMAN** `http://avid.com/interplay/ws/assets/types` (assets) namespace'inde. Jobs çağrısının gövdesi `jobs/types`'ta olsa bile credentials assets'te kalmalı. Çözüm: her envelope'da iki prefix — `c:`=assets (credentials), `b:`/`j:`=gövde.

**Namespace tablosu (zincir için gerekenler):**
| Servis | Mesaj namespace (envelope'da) |
|---|---|
| Assets (K1) | `http://avid.com/interplay/ws/assets/types` |
| Jobs (K2) | `http://avid.com/interplay/ws/jobs/types` |
| **UserCredentials (her zaman)** | `http://avid.com/interplay/ws/assets/types` |
| SOAP Envelope | `http://schemas.xmlsoap.org/soap/envelope/` |

---

## 3. Auth — iki dünya

### 3.1 IPWS (K1/K2): UserCredentials

Her SOAP request'in `<Header>`'ında gider. Token YOK, süresiz.

```xml
<c:UserCredentials xmlns:c="http://avid.com/interplay/ws/assets/types">
  <c:Username>{AVID_USER}</c:Username>
  <c:Password>{AVID_PASSWORD}</c:Password>
</c:UserCredentials>
```

### 3.2 Cloud UX (K3): OAuth2/AD ROPC login → `avidAccessToken` — KALICI ÇÖZÜM [DOĞRULANDI 2026-06-08]

Transfer token'ı **kullanıcı/parola ile programatik üretilir** (elle yapıştırma yok). Saha cluster'ı (172.26.33.56/57) **OAuth2 + Active Directory** kullanıyor; identity-provider **`ropc-default`** (Resource Owner Password Credentials). Web app `init.js`'ten çıkarılıp **gerçek cluster'a karşı canlı doğrulandı** (HTTP 200, token TTL 916s).

> ⚠️ Avid IAM dokümanındaki basit MCUX `/api/auth/login` bu cluster'da **YOK** (→ 405). Gerçek yol aşağıdaki ROPC.

**Adım 1 — ROPC login (token üret):**
```
POST {cloudux}/auth/sso/login/oauth2/ad
Authorization: Basic <base64(client_id:secret)>      ← web app'in gömülü public OAuth client'ı
Content-Type: application/x-www-form-urlencoded
username={USER} & password={PASS} & grant_type=password & no_refresh_token=true & scope=openid

→ 200 OK · Set-Cookie: avidAccessToken=<token>  (+ JSESSION)
```
- **`Authorization: Basic` ZORUNLU** — yoksa `401 invalid_client`. Değer = `init.js`'teki gömülü client (`com.avid.mediacentralcloud-...`). Gizli → `.env` (AVID_CLOUDUX_CLIENT_BASIC).
- **`no_refresh_token=true`** → refresh token YOK → token `/extension` ile canlı tutulur (refresh grant değil).
- TTL ≈ **15 dk**. `iamToken.expiresAt` → `GET {cloudux}/auth/tokens/current` ile okunur.

**Adım 2 — Token'ı geçir:** Cookie `avidAccessToken=...` (BCMS bunu kullanıyor; CTMS `submitSTPJob` sadece bununla çalışıyor — [DOĞRULANDI]). Alternatif: `Authorization: Bearer` · `?_avidAccessToken=`.

**Adım 3 — Yaşam döngüsü:**
| İşlem | İstek | Sonuç |
|---|---|---|
| Doğrula / expiry | `GET /auth/tokens/current` | 200 → `iamToken.expiresAt`; **401 → ölü/iptal** |
| Uzat (keep-alive) | `POST /auth/tokens/current/extension` | yeni `expiresAt` (token rotate olabilir → sakla) |
| İptal | `DELETE /auth/tokens/current` | 204 |

> **🔴 ALTIN KURAL:** Ölen token uzatılamaz → **tek çare yeniden ROPC login.** Eski "restart olunca elle yenile" sınırı bu yüzdendi.

**Kalıcı çözüm (UYGULANDI — `avid.ctms.ts`):**
1. Token yoksa/expiring → **ROPC login** (`postRopcLogin`: kullanıcı/parola + client Basic).
2. `/extension` ile keep-alive; başarısız/token ölü → **re-login**.
3. `submitSTPJob` **401** → `forceRelogin` + **tek retry**.
4. Rotate olan token saklanır; `expiresAt`-tabanlı yenileme.
5. Config: `clouduxUser/Password` (yoksa IPWS `user/password`'a fallback — saha: aynı hesap) + `clouduxClientBasic`.

→ Restart / boşta kalma / hafta sonu sonrası **insan müdahalesi GEREKMEZ** (self-healing).

---

## 4. K1 — ARA: `Assets.Search` [DOĞRULANDI]

`Assets.Search`, `InterplayPathURI` kökünden **server-side recursive** arar. DC kod ile sequence bulur.

**Kurallar:**
- **Condition: yalnız `Equals` ve `Contains` çalışır.** `BeginsWith`/`StartsWith`/`Like`/`Matches` → `INVALID_PARAMETER`. "Başlangıçla eşleş" → `Contains` + client-side `startswith`.
- **Tarih filtresi server-side YOK** (`GreaterThanEquals` reddedildi) → client-side filtrele.
- **`Group` doğru olmalı:** `Display Name` / `Video ID` → `USER`; `Type` / `Path` / `Media Status` / tarihler → `SYSTEM`. Yanlış group = boş sonuç.
- **MOB-dedup zorunlu:** aynı `mobid` birden çok path'te ayrı `AssetDescription` dönebilir → tek asset say (`uri.split("mobid=")[-1]` anahtar).

**Envelope:**
```xml
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:c="http://avid.com/interplay/ws/assets/types">
  <s:Header><c:UserCredentials><c:Username>{USER}</c:Username><c:Password>{PASS}</c:Password></c:UserCredentials></s:Header>
  <s:Body>
    <c:Search>
      <c:InterplayPathURI>interplay://BSVMWG/Projects/</c:InterplayPathURI>
      <c:SearchGroup Operator="AND">
        <c:AttributeCondition Condition="Contains">
          <c:Attribute Name="Display Name" Group="USER">{DC_KOD}</c:Attribute>
        </c:AttributeCondition>
        <c:AttributeCondition Condition="Equals">
          <c:Attribute Name="Type" Group="SYSTEM">sequence</c:Attribute>
        </c:AttributeCondition>
      </c:SearchGroup>
      <c:MaxResults>50</c:MaxResults>
    </c:Search>
  </s:Body>
</s:Envelope>
```

**Sonuç parse:** `AssetDescription > Attributes > Attribute Name="..."` → `{ad: değer}`. Önemli alanlar: `Display Name`, `Video ID` (playlist eşleşme anahtarı, Group=USER), `Type`, `Media Status`, `Modified Date`, `InterplayURI` (mobid buradan).
(BCMS karşılığı: `interplaySearchByDcCode` → `avid.client.ts`.)

---

## 5. K2 — RESTORE: `Jobs.SubmitJobUsingProfile` + `GetJobStatus` [DOĞRULANDI]

Seçilen asset'i DIVA arşivinden Interplay'e getirir. (Zincir: `BSVMMS01 → BSVMAP01 → BSDIVAACTOR01 → DIVA`; IPWS dışında DIVA'ya dokunulmaz.)

**Submit — KRİTİK kurallar:**
- **`SourceServerType=Assets`** — `Archive` sahada `INVALID_PARAMETER` (doc'a rağmen). Sebep: `InterplayURI` Interplay/Assets DB'sindeki **kaydı** gösterir (medyası arşivde).
- **Profile string birebir eşleşmeli** (boşluk/tire dahil): `'BeINSports - Partial Restore'`, `'BeINSports -Full Restore'` (Full'da "-Full" bitişik!). Hardcode etme; `Jobs.GetProfiles` ile canlı çek (`Services` child'ı `<Name>`).
- Partial/Full ayrımı **profilin içinde**; submit'te in/out point yok.
- Rate limit: **20 job/dk**.

```xml
<j:SubmitJobUsingProfile xmlns:j="http://avid.com/interplay/ws/jobs/types">
  <j:Service>com.avid.dms.restore</j:Service>
  <j:Profile>BeINSports - Partial Restore</j:Profile>
  <j:InterplayURI>interplay://BSVMWG?mobid=...</j:InterplayURI>
  <j:SourceServerType>Assets</j:SourceServerType>
</j:SubmitJobUsingProfile>
```
→ Yanıt: `JobURI` (örn. `interplay://BSVMWG/DMS?jobid=...`).

**İzleme — `GetJobStatus(JobURI)`:**
- **Saha status enum'u: `Pending` → `Processing N%` → `Completed`.** (Doc `RUNNING` der; ikisini de tanı.) `Failed`/`Aborted`/`Cancelled` → başarısız. Tanınmayan → `running` (defansif, terminal'e düşürme).
- `Completed` → media online → K3'e hazır.

(BCMS karşılığı: `interplayRequestRestore` + `interplayPollJobStatus` + `mapJobStatus` → `avid.client.ts`.)

---

## 6. K3 — TRANSFER: CTMS `submitSTPJob` [DOĞRULANDI 2026-06-01]

Online asset'i Avid DIŞI yayın havuzuna gönderir. **IPWS `SendToPlayback` terk edildi** (çıplak export mixdown yapmaz, "Cannot import" verir). Cloud UX'in "transfer" butonu CTMS `submitSTPJob` çağırır; **CDS Service mixdown + encode + playback'i kendi orkestra eder.**

```
POST {cloudux}/apis/avid.pam.stp;version=1;realm={realm}/submitSTPJob
Cookie: avidAccessToken={token}
Content-Type: application/json
{
  "stpRequestDTO": {
    "device": "{STP_DEVICE}",          // örn. MCR
    "profile": "{STP_PROFILE}",        // örn. MCR
    "mobId": "{HAM_SEQUENCE_MOBID}",   // companion gerekmez; CDS üretir
    "nodeId": "interplay:{realm}:sequence:{mobId}",
    "processName": "{ASSET_ADI veya DC_KOD}",
    "videoId": "{DC_KOD}",             // TapeID
    "burnGraphics": false, "highPriority": false, "overwrite": false
  }
}

→ 200 { "errorSet": [], "responseData": "{\"jobId\":\"<uuid>\",\"mcdsStatusURL\":\"https://mcds-host:8443/...\"}" }
```

- `errorSet`/`errors` dolu veya HTTP non-2xx → hata. **401/403 → token süresi dolmuş** (§3.2 self-heal: re-login + retry).
- Başarı: iç-içe `responseData` JSON'undan `jobId` çıkar.
- **Status izleme [V1]:** Per-job REST status endpoint'i YOK (mcds-host:8443 erişilemez; UI websocket kullanıyor). `submitSTPJob` 200 = CDS kuyruğuna **kabul edildi** = BCMS'te "DONE" sayılır. Gerçek RUNNING→COMPLETED takibi sonraki faz (WS veya Process job-list REST'i). Operatör nihai sonucu Cloud UX Process ekranından görür.

(BCMS karşılığı: `postSubmitStpJob` + `ctmsRequestTransfer` → `avid.ctms.ts` / `avid.client.ts`.)

---

## 7. Veri modeli — `AssetDescription` [DOĞRULANDI]

Attribute'lar direkt child değil, `<Attributes>` içinde `Name=` ile:
```xml
<AssetDescription>
  <InterplayURI>interplay://BSVMWG?mobid=060a2b34...</InterplayURI>
  <Attributes>
    <Attribute Name="Display Name" Group="USER">DC00036170_KOREN_MANISA_37H_1D</Attribute>
    <Attribute Name="Video ID"     Group="USER">M_KOREN_MANISA_37H_1D</Attribute>
    <Attribute Name="Type"         Group="SYSTEM">sequence</Attribute>
    <Attribute Name="Media Status" Group="SYSTEM">online</Attribute>
    <Attribute Name="Modified Date" Group="SYSTEM">2026-04-27T16:01:16.000+0300</Attribute>
  </Attributes>
</AssetDescription>
```
- **Parser:** `for a in Attributes: map[a["Name"]] = a.text`.
- **İsim kalıbı:** `DC{8hane}_{TAKIM}_{TAKIM}_{H}H_{1D|2D}` · **Video ID:** `M_{maç}_{H}H_{devre}` (playlist eşleşme anahtarı — Display Name değil).
- **Klasör adlarında çoklu boşluk var** (`01   MAC`) — URI string'lerini trim etme.

---

## 8. Açık noktalar / dikkat

**Token (K3) — kalıcı çözüm uygulanırken:**
- **Servis hesabı:** ROPC login, IPWS SOAP ile **aynı AD hesabıyla** çalışıyor (domain'li read-only servis hesabı) — [DOĞRULANDI]. Değerler `.env`'de: `AVID_CLOUDUX_USER/PASSWORD` (yoksa `AVID_USER/PASSWORD`'a fallback) + `AVID_CLOUDUX_CLIENT_BASIC`.
- **303 + Set-Cookie:** login yanıtındaki `avidAccessToken`'ı 303'ten (redirect:'manual') oku ya da yönlendirme sonrası `/auth/tokens/current` gövdesinden `accessToken` al.
- **JSESSION:** login'de yakalanmalı; CTMS'e gerekmedi ama klasik MC kaynağı çağrılırsa lazım.
- **Zamanlama:** sabit interval yerine `iamToken.expiresAt`-tabanlı yenileme.

**Restore/Search:**
- `GetLatest` read-only görünür ama checkout/lock riski — kullanma.
- GUI-tetikli (Media Composer) restore `GetJobStatus` kuyruğunda görünür mü — doğrulanmadı.

**Yayın havuzu hedefi:** CTMS `device`/`profile` (örn. MCR) ile belirlenir; FTP yolu CDS/engine config'inde gömülü (API'ye geçmez).

---

## 9. BCMS kod haritası (bu zincir)

| Kademe | Dosya | Fonksiyon |
|---|---|---|
| K1 ARA | `apps/api/src/modules/avid/avid.client.ts` | `interplaySearchByDcCode`, `buildSearchBody` |
| K2 RESTORE | `apps/api/src/modules/avid/avid.client.ts` | `interplayRequestRestore`, `interplayPollJobStatus`, `mapJobStatus` |
| K3 TRANSFER | `apps/api/src/modules/avid/avid.ctms.ts` | `postSubmitStpJob`, `buildStpRequestBody`, `createCtmsTokenManager` (← login/self-heal eklenecek) |
| SOAP transport | `apps/api/src/modules/avid/avid.soap.ts` | `postSoap` |
| Config/Settings | `avid.config.ts`, `avid.settings.ts` | env + DB override (`clouduxToken` → servis hesabıyla değişecek) |
| Worker | `restore.worker.ts`, `transfer.worker.ts` | tick-based job işleme |

> **Kalıcı çözümün kodda karşılığı (UYGULANDI):** `avid.ctms.ts` → `postRopcLogin` (ROPC `POST /auth/sso/login/oauth2/ad` + Basic client) + token yöneticisi self-heal (`ensureToken`/`forceRelogin`, **401'de re-login**, `expiresAt`-tabanlı yenileme); config `clouduxUser`/`clouduxPassword`/`clouduxClientBasic`. Detay §3.2.
