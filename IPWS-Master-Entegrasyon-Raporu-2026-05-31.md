# IPWS (Avid Interplay Web Services) — Master Entegrasyon Raporu

**Proje:** Playout Media Readiness Monitor (IPWS-restore PoC)
**Rapor tarihi:** 2026-05-31
**Amaç:** Bu repoda test ederek öğrendiğimiz **her şeyi** tek belgede toplamak; başka bir programa (servis / orkestratör / dashboard) entegre edilebilecek seviyede SOAP çağrı mekaniği, namespace tuzakları, veri modeli, deneysel olarak doğrulanmış davranışlar, örnek envelope'lar ve test edilmiş komutlar.
**Kaynak repo:** `~/Project/ipws-restore` (CLAUDE.md, BACKLOG.md, docs/, poc/python, poc/wsdl)

> **Okuma notu — kanıt seviyeleri.** Bu belgede üç etiket kullanılıyor:
> - **[DOĞRULANDI]** — canlı SOAP çağrısı / runtime testiyle birebir gözlendi.
> - **[WSDL]** — sadece WSDL/XSD şemasından okundu, canlı test edilmedi.
> - **[HİPOTEZ/OP-TEYİDİ]** — gözleme dayalı çıkarım, operasyon ekibi teyidi bekliyor.
>
> Entegrasyonda **[DOĞRULANDI]** olanlara güven; diğerlerini kendi ortamında bir kez test et.

---

## ⚡ Bağlantı + Kimlik — Hızlı Referans Kartı (kopyala-yapıştır)

> ⚠️ **GİZLİ — bu kart gerçek kimlik bilgisi içerir.** Bu belgeyi paylaşırken/commit'lerken dikkat. `Presenter01`/`Avid2019` read-only ve **rotate edilmeli** (bkz. §18). Production'da ayrı servis hesabı kullan.

| Parametre | Değer |
|---|---|
| **IPWS host (FQDN)** | `ipws-host.corp.example.local` |
| **IPWS host (IP — DNS yoksa)** | `ipws-host.example.local` |
| **Protokol / port** | HTTP / `80` |
| **Base URL** | `http://ipws-host.corp.example.local/services` |
| **Base URL (IP)** | `http://ipws-host.example.local/services` |
| **Workgroup** | `BSVMWG` |
| **URI prefix** | `interplay://BSVMWG/` |
| **Interplay Engine** | `bsvmipe` |
| **Archive Engine** | `asset-manager-host` |
| **Media Service Engine** | `media-host-01` |
| **Kullanıcı adı** | `Presenter01` *(domain prefix YOK)* |
| **Parola** | `Avid2019` *(read-only test; rotate edilecek)* |
| **Auth yöntemi** | SOAP Header `UserCredentials` (Basic/token yok) |
| **Credentials namespace** | `http://avid.com/interplay/ws/assets/types` *(her zaman — §3 tuzağı)* |

**Endpoint'ler:**
```
http://ipws-host.corp.example.local/services/Assets
http://ipws-host.corp.example.local/services/Archive
http://ipws-host.corp.example.local/services/Transfer
http://ipws-host.corp.example.local/services/Jobs
http://ipws-host.corp.example.local/services/Infrastructure
http://ipws-host.corp.example.local/services/UserManagement
```

**Shell / env (script'lerin okuduğu değişkenler):**
```bash
export IPWS_HOST="http://ipws-host.corp.example.local"   # DNS yoksa: http://ipws-host.example.local
export IPWS_USER="Presenter01"
export IPWS_PASS="Avid2019"
```

**Hızlı smoke test (zarar vermez, read-only):**
```bash
curl -sI "http://ipws-host.example.local/services/Infrastructure?wsdl"   # HTTP 200 beklenir
```

---

## 0. Yönetici özeti — 60 saniyede ne öğrendik

1. **IPWS = Avid'in SOAP/HTTP cephesidir.** 6 servis (`Assets`, `Archive`, `Transfer`, `Jobs`, `Infrastructure`, `UserManagement`), toplam 76 operasyon. Bağımlılık yok — düz HTTP POST + XML ile konuşulabiliyor (zeep/SDK gerekmiyor; biz Python stdlib ile yaptık).
2. **Bu proje read-only bir monitor.** Hiçbir submit/write yapılmaz (tek istisna: 2026-05-20 kullanıcı onaylı restore submit testi). Yasaklı op'ları yanlışlıkla çağırmamak için isim-prefix taraması yapılır.
3. **Yayın hazırlık sinyali için Media Status'a GÜVENME.** Otoriter sinyal `Transfer.CheckSequenceIsReadyForXfer`'dir — ve bu da **`.transfer` suffix'li mixdown** asset üzerinde okunmalıdır (DC sekansında hep `OTHER_ERROR` döner).
4. **Playlist ↔ Avid eşleşmesi `Video ID` ile yapılır**, Display Name ile değil.
5. **Restore zinciri:** `Jobs.SubmitJobUsingProfile` (profile-driven, `SourceServerType=Assets`) → `Jobs.GetJobStatus` ile izlenir → media online olur → `.transfer` Xfer READY'e döner → `Transfer.SendToPlayback` ile Avid-dışı yayın havuzuna gider.
6. **En büyük teknik tuzak: SOAP namespace.** `UserCredentials` her zaman **assets/common** namespace'indedir, çağırdığın servisin kendi namespace'inde değil. Transfer ve Jobs çağrılarında bunu karıştırırsan auth patlar.

---

## 1. Sistem mimarisi — neyin neye konuştuğu

### 1.1 İki ayrı dünya: Avid ≠ Yayın Havuzu

```
┌──────────────────────────┐              ┌─────────────────────────┐
│   AVID INTERPLAY         │  Send to     │   YAYIN HAVUZU          │
│   (IPWS ile eriştiğimiz) │  Playback    │   (Avid'in DIŞINDA,     │
│                          ├─────────────►│    AYRI sistem)         │
│   • online/offline/arch  │   köprü      │   • playout server/MAM  │
│   • restore (DIVA ile)   │              │   • kendi inventory/API │
│   • Avid içi metadata    │              │   • henüz adlandırılmadı │
└──────────────────────────┘              └─────────────────────────┘
       BU PROJENİN ALANI                       KAPSAM DIŞI (sonraki faz)
```

- IPWS yalnızca **Avid tarafını** görür. "Asset yayın havuzunda var mı?" sorusu **IPWS ile cevaplanamaz**.
- Avid içindeki `Sent to Playback` subtree'si, dış havuza gönderilmiş asset'lerin **Avid-tarafı kaydıdır**, gerçek havuz değildir. (Proje kuralı: bu subtree'ye sorgu gönderilmiyor.)

### 1.2 Restore zinciri (DIVA'ya direkt konuşulmaz)

```
BSVMMS01 (PSE/Media Services) → BSVMAP01 (Restore Provider) → BSDIVAACTOR01 (AMC) → DIVA
```

DIVA arşiv katmanının en altında. **IPWS dışında hiçbir API/CLI ile DIVA'ya dokunulmaz.** Restore'u IPWS `Jobs.SubmitJobUsingProfile` tetikler, gerisini bu zincir halleder.

### 1.3 Tam yaşam döngüsü zinciri (uçtan uca, canlı doğrulandı)

```
Arşivde (media offline)
   │  Jobs.SubmitJobUsingProfile   profile-driven, SourceServerType=Assets   [DOĞRULANDI ✓ onaylı]
   ▼
Online (full restore → master clip komple geri geldi)
   │  Transfer.CheckSequenceIsReadyForXfer   read-only, .transfer üzerinde     [DOĞRULANDI ✓ READY]
   ▼
Yayına hazır
   │  Transfer.SendToPlayback   device-driven (engine + DestinationPlaybackDevice)   [WSDL — keşfedildi, çağrılmadı]
   ▼
Playout (PCR / MCR / GURME_PCR ... — Avid DIŞI havuz)
```

---

## 2. Altyapı ve bağlantı

### 2.1 Adresler

| Bileşen | Değer |
|---|---|
| IPWS host (FQDN) | `ipws-host.corp.example.local` |
| IPWS host (IP) | `ipws-host.example.local` |
| HTTP port | 80 (TCP açık, ~0.2 ms latency — aynı LAN) |
| Workgroup | `BSVMWG` |
| URI prefix | `interplay://BSVMWG/` |
| Interplay Engine | `bsvmipe` |
| Archive Engine | `asset-manager-host` |
| Media Service Engine | `media-host-01` |
| Avid domain | `corp.example.local` |
| Corp domain | `DIGITURK.LOCAL` |
| Corp DNS | `dns1.example.local` (primary), `dns2.example.local` (secondary) |

### 2.2 SOAP endpoint'leri

```
http://ipws-host.corp.example.local/services/Assets
http://ipws-host.corp.example.local/services/Archive
http://ipws-host.corp.example.local/services/Transfer
http://ipws-host.corp.example.local/services/Jobs
http://ipws-host.corp.example.local/services/Infrastructure
http://ipws-host.corp.example.local/services/UserManagement
```

- WSDL almak için `?wsdl` eki: `…/services/Assets?wsdl`.
- **[DOĞRULANDI]** Sunucu host-header binding zorlamıyor: IP üzerinden de çalışıyor (`http://ipws-host.example.local/services/Transfer?wsdl` → HTTP 200). DNS çözülemediğinde IP ile bypass mümkün.

### 2.3 DNS tuzağı (Ubuntu geliştirme makinesi) — [DOĞRULANDI]

systemd-resolved default'ta `.local`'i mDNS'e yönlendirir; `corp.example.local` için **REFUSED** döner. Runtime fix:

```bash
sudo resolvectl domain eno1 DIGITURK.LOCAL '~corp.example.local'
```

`~` prefix = routing domain (eno1'in unicast DNS'ine bu zone için sorgu gider). **Network restart sonrası NetworkManager sıfırlar** — kalıcı için NetworkManager profilinde tanımlanmalı. Geçici alternatif: `IPWS_HOST` env var'ını IP'ye set et (aşağıda).

---

## 3. Authentication

- **Test kullanıcısı (PoC):** `Presenter01` / parola `Avid2019` — read-only. ⚠️ **Yandı sayılır, rotate edilmeli** (bkz. §14 Güvenlik).
- **Username formatı:** doğrudan `Presenter01`. **Domain prefix YOK** (`DIGITURK\` vs. gerekmedi).
- Auth, her SOAP request'in `<Header>`'ında `UserCredentials` ile gönderilir. HTTP Basic Auth / token yok.

```xml
<types:UserCredentials>
  <types:Username>Presenter01</types:Username>
  <types:Password>Avid2019</types:Password>
</types:UserCredentials>
```

> **🔑 KRİTİK NAMESPACE TUZAĞI — [DOĞRULANDI]**
> `UserCredentials` her zaman **Assets/common namespace**'ine aittir: `http://avid.com/interplay/ws/assets/types`.
> Transfer veya Jobs çağrısı yaparken request body'si o servisin namespace'inde olsa bile, `UserCredentials` **assets** namespace'inde kalmalı (çünkü Transfer/Jobs WSDL'leri credential tipini common'dan import eder). Bizim çözümümüz: her envelope'da iki namespace bildir, credentials'ı `c:` (=assets) prefix'iyle yaz, body'yi `t:`/`j:` (=transfer/jobs) prefix'iyle. Karıştırırsan auth hatası/SOAP fault alırsın.

---

## 4. SOAP çağrı mekaniği (transport seviyesi)

Tüm çağrılar aynı kalıp. Hiçbir SOAP kütüphanesi gerekmez — düz HTTP POST yeterli.

**HTTP:**
- Metot: `POST`
- Header: `Content-Type: text/xml; charset=utf-8`
- Header: `SOAPAction: ""` (boş string — **[DOĞRULANDI]** çalışıyor; doc/literal action gerekmedi)
- Body: aşağıdaki SOAP envelope

**Hata davranışı — [DOĞRULANDI]:**
- İş-seviyesi hatalar genelde **HTTP 200** içinde `<Errors><Error Code="...">…</Error></Errors>` olarak döner (response gövdesinde).
- Bazı protokol hataları **HTTP 500 + SOAP Fault** olarak döner — gövdeyi yine de oku, `<Fault>` parse et.
- `urllib`'de `HTTPError` yakalanıp gövdesi okunmalı (Python `urlopen` 4xx/5xx'te exception atar ama gövde `e.read()` ile alınır).

**Response yapısı (Error tipi, common.xsd'den) — [WSDL]:**
```xml
<Error Code="MEDIA_OFFLINE">
  <InterplayURI>interplay://...</InterplayURI>   <!-- opsiyonel -->
  <Message>kısa açıklama</Message>
  <Details>debug detayı</Details>
</Error>
```
`Code` zorunlu attribute. `Message` + `Details` zorunlu element. Hata yoksa `<Errors>` bloğu tamamen **omit edilir**.

**Parser stratejisi (tüm script'lerde ortak):** namespace-agnostik. Element'in `localname`'ine bak (`tag.split("}")[-1]`), full-qualified name ile uğraşma — Avid bazen prefix/namespace varyasyonu döndürür.

---

## 5. Namespace referans tablosu

| Servis | Endpoint | WSDL targetNamespace | Mesaj/types namespace (envelope'da kullanılan) |
|---|---|---|---|
| Assets | `/services/Assets` | `http://avid.com/interplay/ws/assets` | `http://avid.com/interplay/ws/assets/types` |
| Archive | `/services/Archive` | `http://avid.com/interplay/ws/archive` | `http://avid.com/interplay/ws/archive/types` |
| Transfer | `/services/Transfer` | `http://avid.com/interplay/ws/transfer` | `http://avid.com/interplay/ws/transfer/types` |
| Jobs | `/services/Jobs` | `http://avid.com/interplay/ws/jobs` | `http://avid.com/interplay/ws/jobs/types` |
| Infrastructure | `/services/Infrastructure` | `http://avid.com/interplay/ws/infrastructure` | `http://avid.com/interplay/ws/infrastructure/types` |
| UserManagement | `/services/UserManagement` | `http://avid.com/interplay/ws/user` | `http://avid.com/interplay/ws/user/types` |
| SOAP Envelope | — | — | `http://schemas.xmlsoap.org/soap/envelope/` |
| **UserCredentials (HER ZAMAN)** | — | — | `http://avid.com/interplay/ws/assets/types` |

> Dikkat: WSDL `targetNamespace` ile **mesaj** namespace'i farklı — mesajlar `/types` ile biter. Envelope'da `/types` olanı kullan.

---

## 6. Operasyon envanteri (6 servis, 76 op) — read-only / mutating

**Sınıflandırma kuralları:**

| Prefix | Sınıf | İstisna / not |
|---|---|---|
| `Get*`, `Find*`, `List*`, `Search` | read-only | — |
| `CheckSequenceIs*` | **read-only** | [DOĞRULANDI] WSDL + runtime preflight |
| `CheckIn*` (CheckIn, CheckInAAF, CheckInAMAAAF) | **WRITE** | İsim aldatıcı — "source control'e commit et" demek |
| `Set*`, `Save*`, `Modify*`, `Add*`, `Remove*`, `Create*`, `Delete*`, `Move`, `Rename`, `Duplicate`, `LinkTo*`, `Submit*`, `Cancel*`, `Pause*`, `Resume*`, `Retry*`, `Send*` | WRITE | — |

| Servis | Toplam | Read-only | Mutating | Projedeki rol |
|---|---|---|---|---|
| **Assets** | 42 | 17 | 25 | Ana servis — sequence/asset arama, attribute okuma |
| **Archive** | 9 | 6 | 3 | Arşivlenmiş asset görünürlüğü |
| **Transfer** | 7 | 5 | 2 | Readiness check (ana use case) + STP |
| **Jobs** | 9 | 2 | 7 | Job durumu izleme + (onaylı) restore submit |
| **Infrastructure** | 2 | 2 | 0 | Versiyon/config — smoke test |
| **UserManagement** | 7 | 2 | 5 | Proje için ilgisiz |
| **TOPLAM** | **76** | **34** | **42** | — |

### 6.1 Assets — `/services/Assets`

**Read-only (17):** `Search` ⭐, `GetChildren` ⭐, `GetAttributes` ⭐, `FindRelatives` ✓, `FindLinks`, `GetSegmentsFromComposition`, `GetFileDetails`, `GetLatest` ⚠️, `GetCategories`, `GetCustomUserAttributes`, `GetHeadframe`, `GetLocators` (deprecated), `GetUMIDLocators`, `GetReservations`, `GetResolutions`, `GetRestrictions`, `GetStreamingURL`.

⚠️ **`GetLatest`** read-only kategoride **ama** Avid'de checkout/lock semantiği olabilir — çağırmadan önce test et (henüz doğrulanmadı).

**Mutating (25) — YASAKLI:** AddFileMobs, AddReservation, AddRestrictions, CheckIn, CheckInAAF, CheckInAMAAAF, CreateFolder, CreateFolders, CreateMasterClip, CreateShotlist, CreateSubclip, DeleteAssets, Duplicate, LinkToMOB, ModifyFolderACLs, Move, RemoveLocators, RemoveReservations, RemoveUMIDLocators, Rename, SaveLocators, SaveUMIDLocators, SetAttributes, SetCategories, SetHeadframe.

### 6.2 Archive — `/services/Archive`

**Read-only (6):** Search, GetAttributes, GetFileDetails, GetChildren, GetHeadframe, GetLatest. — Assets ile aynı semantik ama **Interplay Archive DB** üzerinde.
**Mutating (3) — YASAKLI:** CheckInAAF, CreateFolders, SetFileStatus.

### 6.3 Transfer — `/services/Transfer` ⭐ projenin omurgası

**Read-only (5):** `CheckSequenceIsReadyForXfer` ⭐, `CheckSequenceIsReadyForMixDown` ⭐, `GetTransferDevices`, `GetIndexedWorkspaces`, `ListTransferEngines`.
**Mutating (2) — YASAKLI:** `SendToPlayback`, `SendToWG`.

### 6.4 Jobs — `/services/Jobs`

**Read-only (2):** `GetJobStatus` ⭐, `GetProfiles`.
**Mutating (7) — YASAKLI:** `SubmitJobUsingProfile` (2026-05-20 onaylı test edildi), SubmitJobUsingParameters, CancelJobs, DeleteJobs, PauseJobs, ResumeJobs, RetryJobs.
⚠️ SubmitJob*'lar **dakika başına 20 job** ile rate-limited (WSDL doc). `DeleteJobs` bir Transfer job'unda pause + error döndürdü (write side-effect).

### 6.5 Infrastructure — `/services/Infrastructure`

**Read-only (2 — hepsi):** `GetVersionInformation`, `GetConfigurationInformation`. Mutating yok — bağlantı/auth smoke test için ideal, zarar veremez.

### 6.6 UserManagement — `/services/UserManagement`

**Read-only (2):** GetUsers, GetGroups.
**Mutating (5) — YASAKLI:** CreateGroups, CreateUsers, DeleteGroups, ModifyGroup, ModifyUsers.

---

## 7. Veri modeli — AssetDescription

### 7.1 Şekil (kritik) — [DOĞRULANDI]

Avid attribute'ları **direkt child element olarak değil**, `<Attributes>` içinde `Name=` kalıbıyla döndürür:

```xml
<AssetDescription>
  <InterplayURI>interplay://BSVMWG?mobid=060a2b34...</InterplayURI>
  <Attributes>
    <Attribute Name="Display Name"  Group="USER">DC00036170_KOREN_MANISA_37H_1D</Attribute>
    <Attribute Name="Type"          Group="SYSTEM">sequence</Attribute>
    <Attribute Name="Path"          Group="SYSTEM">/Projects/.../...</Attribute>
    <Attribute Name="Media Status"  Group="SYSTEM">online</Attribute>
    <Attribute Name="Video ID"      Group="USER">M_KOREN_MANISA_37H_1D</Attribute>
    <Attribute Name="Creation Date" Group="SYSTEM">2026-04-26T17:16:54.000+0300</Attribute>
    <Attribute Name="Modified Date" Group="SYSTEM">2026-04-27T16:01:16.000+0300</Attribute>
    <Attribute Name="Created By"    Group="SYSTEM">avid-admin</Attribute>
    <Attribute Name="Modified By"   Group="SYSTEM">dtogoksu</Attribute>
    <Attribute Name="Moniker"       Group="SYSTEM">1|GUID|*|ID|*</Attribute>
  </Attributes>
</AssetDescription>
```

**Parser kuralı:** `for a in <Attributes>: name = a.attrib["Name"]; value = a.text`. Dictionary'e at: `{name: value}`.

### 7.2 Önemli alanlar ve davranışları

| Attribute | Group | Not |
|---|---|---|
| `Display Name` | USER | `DC########_TAKIM_TAKIM_HH_ND` (editör) veya `M_..._.transfer` (mixdown) |
| `Video ID` | **USER** | **Playlist eşleşme anahtarı.** `M_TAKIM_TAKIM_HH_ND`. Arama Group="USER" ile. |
| `Type` | SYSTEM | lowercase: `folder`, `sequence`, `project`, `catalog`, `workspace`, `playbackdevices`, `localbin`, `category`, `masterclip` |
| `Media Status` | SYSTEM | `online`/`offline`/`archived`/`partial` — ⚠️ **yanıltıcı, §10.4** |
| `Path` | SYSTEM | İnsan-okunur path; **aynı asset 2 path'te görünebilir** |
| `Creation/Modified Date` | SYSTEM | ISO 8601 + ms + tz, `+0300`/`+0400` (DST) — **kolonsuz** offset |
| `Modified By` | SYSTEM | Preflight için kritik (state-change kanıtı) |
| `Duration`, `Tracks`, `CFPS` | — | Süre/track/fps metadata |

### 7.3 MOB URI ve dedup — [DOĞRULANDI]

- Sequence URI'leri **path tabanlı değil, MOB ID tabanlı**:
  ```
  interplay://BSVMWG?mobid=060a2b340101010501010f1013-000000-...
  ```
- Search aynı MOB ID'yi **birden fazla path için ayrı `AssetDescription`** olarak döndürebilir (asset 2 yerde "yaşıyor", kopya değil — link).
- **Dedup zorunlu:** `mob = uri.split("mobid=")[-1]`; aynı mobid'i tek asset say, path'leri listeye topla.

### 7.4 Avid kök yapısı — [DOĞRULANDI]

`interplay://BSVMWG/` → 6 sistem klasörü:

```
interplay://BSVMWG/
├── [project]          Projects                  ← üretim projeleri (21 alt klasör, 2010-2026)
├── [catalog]          Catalogs                  ← aranabilir asset katalogları
├── [workspace]        Incoming Media            ← yeni ingest
├── [playbackdevices]  Sent to Playback          ← ⛔ DOKUNMA (proje kuralı)
├── [localbin]         Unchecked-in Avid Assets  ← henüz commit edilmemiş
└── [Asset]            Deleted Items             ← recycle bin
```

---

## 8. İsim ve path konvansiyonları (BeIN Sports üretim sahası)

### 8.1 Display Name kalıbı

```
DC + 8 haneli ID + _ + TAKIM_TAKIM + _ + hafta(H) + _ + devre(1D|2D)
Örnek: DC00036174_PENDIK_BOLU_37H_1D  = ID 36174, Pendik vs Bolu, 37. hafta, 1. devre
```

### 8.2 Video ID kalıbı (playlist eşleşmesi)

```
M + _ + maç + hafta + devre
Display Name:  DC00036170_KOREN_MANISA_37H_1D
Video ID:      M_KOREN_MANISA_37H_1D
```

⚠️ **[OP-TEYİDİ bekliyor]** Display Name ile Video ID arasında yazım farkları olabiliyor:
- Avid Video ID: `M_ERZURUM_BANDRMA_37H_2D` (BANDRMA — "I" harfsiz)
- Display Name:  `DC00036173_ERZ_BANDIRMA_37H_2D` (BANDIRMA — tam)
Playlist hangi formatı gönderir, case-sensitive mi → operasyon teyidi gerekiyor.

### 8.3 Aynı Video ID için 2 sequence (mixdown kalıbı)

| Versiyon | Display Name | Davranış |
|---|---|---|
| Editor | `DC########_...` | Tekrar düzenlenebilir |
| Mixdown | `M_..._.transfer` | DC'den 1-3 dk sonra oluşmuş, dondurulmuş |

**[DOĞRULANDI/EMPİRİK]** STP'e giden **canonical versiyon `.transfer` suffix'li olan**. `CheckSequenceIsReadyForXfer` yalnızca `.transfer` üzerinde anlamlı çalışır.

⚠️ **Mixdown geçici bir state'tir.** `.transfer` mixdown'ları periyodik bakım temizliğinde silinir — varlığı kalıcı readiness sinyali değil. Yokluğu "mixdown gerek" demektir (State B), arıza değil.

### 8.4 İki path kalıbı

Bir sequence aynı anda iki yerde görünür (MOB link):
1. **Ingest path:** `/Projects/ARSIV ISLEMLERI/03 USERS/INGESTROOM/INGESTROOM/COMPOSER 1/<mobid>`
2. **Broadcast copy path:** `/Projects/01   MAC/FUTBOL/01 TURKIYE/02  TFF  1.LIG/SEZON 2025-2026/<H>.HAFTA/01 BROADCAST COPY/<mobid>`

⚠️ **Klasör isimlerinde çoklu boşluk var** (`01   MAC` = 3 boşluk, `02  TFF  1.LIG`). String literal'lerinde aynen koru, trim etme.
⚠️ `01 BROADCAST COPY` **yayın havuzu sinyali DEĞİL** — sadece Avid içi planlama dizini (eski hipotez yanlıştı).

---

## 9. Search semantiği — [DOĞRULANDI]

### 9.1 Davranış

`Assets.Search`, verilen `InterplayPathURI` kökünden **server-side recursive** arama yapar. `SearchGroup` içinde AND/OR ile çok `AttributeCondition` birleştirilir.

```xml
<types:Search>
  <types:InterplayPathURI>interplay://BSVMWG/Projects/</types:InterplayPathURI>
  <types:SearchGroup Operator="AND">
    <types:AttributeCondition Condition="Contains">
      <types:Attribute Name="Display Name" Group="USER">DC0003617</types:Attribute>
    </types:AttributeCondition>
    <types:AttributeCondition Condition="Equals">
      <types:Attribute Name="Type" Group="SYSTEM">sequence</types:Attribute>
    </types:AttributeCondition>
  </types:SearchGroup>
  <types:MaxResults>200</types:MaxResults>
</types:Search>
```

### 9.2 Condition string'leri — deneysel sonuç (KRİTİK)

| Condition | Durum |
|---|---|
| `Equals` | ✅ **[DOĞRULANDI]** kabul |
| `Contains` | ✅ **[DOĞRULANDI]** kabul |
| `BeginsWith` | ❌ INVALID_PARAMETER |
| `StartsWith` | ❌ INVALID_PARAMETER |
| `Like` | ❌ INVALID_PARAMETER |
| `Matches` | ❌ INVALID_PARAMETER |
| `GreaterThanEquals` | ❌ INVALID_PARAMETER (date karşılaştırması için doğru string **henüz bilinmiyor**) |

> **Pratik sonuç:** Yalnızca `Equals` ve `Contains` kullan. "BeginsWith" davranışı istiyorsan `Contains` + client-side `startswith()` filtresiyle taklit et (script'lerimiz böyle yapıyor). Tarih aralığı filtresi server-side **çalışmıyor** — client-side filtrele.

### 9.3 Group değeri önemli

- `Display Name`, `Video ID` → `Group="USER"`
- `Type`, `Path`, `Media Status`, `Creation Date`, `Modified Date` → `Group="SYSTEM"`

Yanlış Group ile arama boş döner. Video ID araması **mutlaka** `Group="USER"`.

---

## 10. Readiness modeli — projenin kalbi

### 10.1 İki operasyon

| Op | Anlamı |
|---|---|
| `Transfer.CheckSequenceIsReadyForXfer` | "Sequence transfer/STP-ready mi?" |
| `Transfer.CheckSequenceIsReadyForMixDown` | "Sequence mixdown alınabilir mi?" |

**Girdi [WSDL]:** `InterplayURI` (zorunlu) + `TargetResolution` (opsiyonel).
**Çıktı [WSDL]:** sadece opsiyonel `<Errors>`. XSD birebir: *"A successful operation does not have any resulting return objects."*
→ Bool dönmez. **Hata yoksa = READY; varsa = NOT READY (gerekçeli).**

### 10.2 Read-only olduğu kanıtlandı — [DOĞRULANDI]

İsim "Check" diye write sanılabilir; iki yolla doğrulandı:
1. **WSDL:** Response sadece `<Errors>`, mutating op'ların aksine JobID/ReservationID/lock dönmüyor → saf predicate.
2. **Runtime preflight** (`ipws_check_ready.py DC00036170`): Çağrı öncesi/sonrası `Modified Date` + `Modified By` **değişmedi**, checkout/lock olmadı, `Modified By` bizim kullanıcımıza dönmedi.

| | Modified Date | Modified By |
|---|---|---|
| ANTE | `2026-04-27T16:01:16.000+0300` | `dtogoksu` |
| POST (2 Check + 2 sn) | `2026-04-27T16:01:16.000+0300` | `dtogoksu` |

### 10.3 Gözlenen error code'ları — [DOĞRULANDI]

| Code | Anlam | Nerede gözlendi |
|---|---|---|
| `MEDIA_OFFLINE` | Medya offline (arşivde) | MixDown check, offline source |
| `OTHER_ERROR` | "An uncategorized error has occurred" | DC sekansında Xfer check **her zaman** (READY iken bile) |
| `INVALID_PARAMETER` | Geçersiz parametre/condition | Search condition'ları, SourceServerType=Archive |

### 10.4 DERS — Media Status YANILTIR (en kritik bulgu) — [DOĞRULANDI]

| Test | Eylem | Sonuç |
|---|---|---|
| 1 | DC sekansına **Partial** restore | `Media Status` → `online` oldu **AMA** Check op'ları hâlâ `MEDIA_OFFLINE` (kalıcı, gecikme değil) |
| 2 | Master clip'e **Full** restore | DC MixDown + `.transfer` Xfer checkleri `MEDIA_OFFLINE → READY` flip |

→ **`Media Status='online'` KABA bir flag.** Bir miktar online medya olunca döner, mal komple online olmasa bile. **Yayına-hazırlık kararı asla `Media Status`'a dayanmamalı.** Otoriter sinyal `CheckSequenceIsReadyForXfer`.

> **Dürüstlük notu:** Test 2'de iki değişken birden değişti (partial→full **ve** hedef DC→master clip). Flip'i tek başına "full" faktörüne kesin atfetmiyoruz; pratik sonuç: tam restore sonrası tam hazır.

### 10.5 DERS — `.transfer` canonical, DC değil — [DOĞRULANDI]

- DC sekansında `CheckSequenceIsReadyForXfer` **READY durumda bile** hep `OTHER_ERROR` döner (DC doğrudan transfer hedefi değil).
- `.transfer` companion'da Xfer check **anlamlı**: offline'da `MEDIA_OFFLINE`, full restore sonrası `READY`.
- → **STP readiness sinyali `.transfer` üzerinden okunur.** DC'nin Xfer hatası "arıza" değildir, yok sayılır.
- DC'de **MixDown** check ise anlamlı (`MEDIA_OFFLINE` net döner) — source availability sinyali için DC-MixDown kullanılabilir.

### 10.6 A/B/C state modeli (`ipws_readiness.py`) — canlı doğrulandı (C örneği)

```
A  — Hazır:        .transfer var + .transfer Xfer ready          → şimdi STP edilebilir
A? — Hazır?:       .transfer var ama Xfer-ready değil             → incele
B  — Mixdown gerek: .transfer yok ama DC MixDown ready (source online)
C  — Soğukta:      DC MixDown = MEDIA_OFFLINE (source arşivde)    → restore+mixdown+STP gerek
?  — Bilinmeyen:    error pattern kategorilere oturmadı
```

Teşhis algoritması (psödokod):
```
if .transfer mevcut:
    if .transfer Xfer READY     -> A (Hazır)
    else                        -> A? (incele)
else:
    if DC MixDown READY         -> B (Mixdown gerek)
    elif MEDIA_OFFLINE in DC MixDown errors -> C (Soğukta)
    else                        -> ? (Bilinmeyen)
```

`DC00036170_KOREN_MANISA_37H_1D` için ilk canlı sinyal: **State C** (Xfer=OTHER_ERROR, MixDown=MEDIA_OFFLINE → source arşivde).

---

## 11. Restore — `Jobs.SubmitJobUsingProfile` — [DOĞRULANDI, onaylı istisna]

> **Yönetişim:** Bu op **mutating/yasaklı**. 2026-05-20'de kullanıcının açık, o-seferlik onayıyla canlı test edildi. Default davranış kalıcı read-only. Submit script'i (`ipws_restore_submit.py`) **default dry-run**; gerçek çağrı için `--execute` şart.

### 11.1 Girdi (4 anlamlı parametre)

```xml
<j:SubmitJobUsingProfile>
  <j:Service>com.avid.dms.restore</j:Service>
  <j:Profile>BeINSports - Partial Restore</j:Profile>
  <j:InterplayURI>interplay://BSVMWG?mobid=...</j:InterplayURI>
  <j:SourceServerType>Assets</j:SourceServerType>
</j:SubmitJobUsingProfile>
```

### 11.2 KRİTİK BULGU — `SourceServerType=Assets` — [DOĞRULANDI]

- **`Assets` çalışır. `Archive` → `INVALID_PARAMETER`.**
- Sebep: `InterplayURI` bir asset **kaydını** gösterir, kayıt Interplay/**Assets** DB'sindedir (sadece *medyası* arşivde). Medyayı DIVA'dan getirmeyi restore profile yapar; `SourceServerType` kaydın nerede olduğunu söyler.
- ⚠️ XSD dokümantasyonu "Archive ve Assets (default) geçerli" diyor — **ama sahada Archive reddedildi.** Doc ≠ saha davranışı; **Assets kullan.** (Önceki "Archive olmalı" varsayımı yanlıştı.)

### 11.3 Profile string'leri (saha, com.avid.dms.restore) — [DOĞRULANDI]

```
'BeINSports - Partial Restore'      (tire etrafında boşluk)
'BeINSports -Full Restore'          (⚠️ Full'da "tire-boşluk" farkı: "-Full")
'Gurme - Partial Restore'
'Gurme - Full Restore'
```

- **Profile string birebir eşleşmeli** — boşluk/tire farkı dahil. Hardcode etme, `Jobs.GetProfiles` ile canlı çek.
- **Partial/Full ayrımı profile İÇİNDE.** Submit'te in/out point YOK — Avid Media Services partial aralığını sekans metadata'sından kendi çıkarır.

### 11.4 `GetProfiles` tuzağı — [DOĞRULANDI]

`GetProfiles` request'inde `Services` listesinin child element'i **`<Name>`**'dir, `<Service>` değil:
```xml
<j:GetProfiles>
  <j:WorkgroupURI>interplay://BSVMWG</j:WorkgroupURI>
  <j:Services><j:Name>com.avid.dms.restore</j:Name></j:Services>
  <j:ShowParameters>true</j:ShowParameters>
</j:GetProfiles>
```

### 11.5 Yanıt ve izleme

- Yanıt: `JobURI` (örn. `interplay://BSVMWG/DMS?jobid=...`).
- `Jobs.GetJobStatus(JobURI)` ile izlenir.
- **Status enum (gözlenen) — [DOĞRULANDI]:** `Pending` → `Processing N%` → `Completed`.
  ⚠️ Reference guide/XSD `RUNNING` diyor — **saha `Processing` kullanıyor.** Status string'ini hardcode karşılaştırma yaparken ikisini de tanı.
- `PercentComplete` yalnızca işlem sürerken anlamlı (XSD: "only valid when RUNNING").
- **[DOĞRULANDI]** IPWS-submit edilen restore `GetJobStatus`'ta görünüyor. ⚠️ **Açık:** GUI-tetikli (Media Composer'dan) restore aynı queue'da görünür mü — test edilmedi.

---

## 12. Media chain — `Assets.FindRelatives` — [DOĞRULANDI]

`DC00036170_KOREN_MANISA_37H_1D` → **1 master clip**:
`M-260426-(GRAFIKLI)-KECIORENGUCU-MANISA-(TFF-25-26)-HAFTA-37`
(GRAFIKLI = grafikleri yakılmış yayın kopyası → tek kaynak klip)

- FindRelatives doğrudan kaynak master clip'i döndürdü.
- Checkleri offline tutan, bu master clip'in **parçalı medyasıydı** (partial restore sonrası); **full restore çözdü**.
- Partial restore'un tam olarak neyi getireceğini önizlemek için `GetSegmentsFromComposition` (in/out segment'leri) + her node için `GetAttributes` ile media status agregasyonu yapılabilir (henüz tam test edilmedi).

---

## 13. Transfer / Send to Playback yolu — [WSDL + keşif, ÇAĞRILMADI]

> `SendToPlayback` **mutating/yasaklı** — Avid **dışındaki** yayın havuzuna gönderir. Sadece read-only keşfedildi.

### 13.1 Profile değil, device-driven

Transfer hedefleri `Jobs.GetProfiles`'tan **gelmez** (restore/archive gibi değil). Her **playback device aslında FTP'si engine config'inde gömülü bir hedeftir**.

**Girdi [WSDL]:**
```xml
<t:SendToPlayback>
  <t:TransferEngineHostName>playback-engine-01</t:TransferEngineHostName>
  <t:InterplayURI>interplay://BSVMWG?mobid=...</t:InterplayURI>   <!-- canonical .transfer -->
  <t:DestinationPlaybackDevice>PCR</t:DestinationPlaybackDevice>  <!-- = device/profil adı -->
  <t:Priority>NORMAL</t:Priority>                                  <!-- NORMAL | PWT | UNASSIGNED -->
  <t:Overwrite>false</t:Overwrite>                                <!-- opsiyonel boolean -->
</t:SendToPlayback>
```
Yanıt: `JobURI` (XFER segment) → `GetJobStatus` ile izlenir.

### 13.2 Altyapı envanteri — [DOĞRULANDI]

- **5 Transfer Engine** (`ListTransferEngines`): `playback-engine-01`, `playback-engine-02`, `playback-engine-03`, `playback-engine-04`, `playback-engine-05`.
- **47 PLAYBACK cihazı** (`GetTransferDevices(host, PLAYBACK)`): playback-engine-01→3 (PCR, MCR, GURME_PCR), 02→7, 03→10, 04→12, 05→15.
- **FTP lokasyonu profilin içinde gömülü — ve bilmeye gerek yok.** API cihaz başına sadece `Name` + `Type` döner; FTP yolunu engine kendi resolve eder. Göndermek için sadece **(engine + device adı)** çifti yeter.
- Yayın hedefi tahmini **[OP-TEYİDİ]:** playback-engine-01 + PCR/MCR.

---

## 14. API kullanımı — öğrenilen dersler (entegrasyon checklist)

Başka bir programa entegre ederken bunları **baştan** doğru yap:

1. **[Namespace] `UserCredentials` daima assets/types namespace'inde.** Transfer/Jobs body'si kendi namespace'inde olsa bile credentials assets'te kalır. → Her envelope'da iki ns prefix tanımla (`c:`=assets credentials, `t:`/`j:`=body).
2. **[Namespace] Mesaj ns'i `/types` ile biter**, WSDL targetNamespace ile değil. (`.../assets/types`, `.../jobs/types`...)
3. **[Parsing] Namespace-agnostik parse et.** Element'in `localname`'ine bak (`tag.split("}")[-1]`). Avid prefix/ns varyasyonu döndürebilir; full-qualified eşleştirme kırılgan.
4. **[Parsing] Attribute'lar `<Attributes>` içinde `Name=` ile.** Direkt child element değil.
5. **[Search] Sadece `Equals` ve `Contains` çalışıyor.** BeginsWith/Like/StartsWith/Matches → INVALID_PARAMETER. "Başlangıçla eşleş" client-side filtrele.
6. **[Search] Date condition server-side YOK.** `GreaterThanEquals` reddedildi, doğru string bilinmiyor → client-side tarih filtrele.
7. **[Search] `Group` doğru olmalı.** Display Name/Video ID = USER; Type/Path/Date/Media Status = SYSTEM. Yanlış group = boş sonuç.
8. **[Dedup] MOB ID ile dedup şart.** Aynı asset çok path'te ayrı AssetDescription olarak döner. `mobid=` parçasını anahtar yap.
9. **[Readiness] Media Status'a güvenme.** Otoriter sinyal `CheckSequenceIsReadyForXfer`, üstelik `.transfer` companion üzerinde. DC-Xfer hep OTHER_ERROR (yok say).
10. **[Readiness] Check op'larının çıktısı yok/hata var ikiliği.** Boş `<Errors>` = READY. Bool dönmez.
11. **[Restore] `SourceServerType=Assets`** (Archive reddediliyor, doc'a rağmen).
12. **[Restore] Profile string birebir** (boşluk/tire farkı dahil); `GetProfiles` ile canlı çek; `Services` child'ı `<Name>`.
13. **[Restore] Job status saha enum'u `Processing`**, doc'taki `RUNNING` değil. İkisini de tanı.
14. **[HTTP] `SOAPAction: ""` (boş) çalışıyor.** İş hataları HTTP 200'de `<Errors>`; protokol hataları HTTP 500 + `<Fault>` — gövdeyi her durumda oku.
15. **[Güvenlik/idempotency] Side-effect şüphesi olan op'ta preflight yap:** Modified Date/By'ı önce/sonra karşılaştır; değişirse abort. (`CheckSequenceIs*` için yaptık, temiz çıktı.)
16. **[Op semantiği] İsim aldatıcı:** `CheckIn*` = WRITE (commit), `CheckSequenceIs*` = READ. `GetLatest` read-only görünüyor ama checkout/lock riski var — test etmeden production'da kullanma.
17. **[Path] Klasör isimlerinde çoklu boşluk var** (`01   MAC`). URI string'lerini trim etme/normalize etme.
18. **[Bağlantı] DNS yoksa IP ile bypass** (`IPWS_HOST=http://ipws-host.example.local`) — sunucu host-header zorlamıyor.
19. **[Eşleşme] Playlist↔Avid = Video ID**, Display Name değil.
20. **[Rate limit] SubmitJob* = dakikada 20 job** (WSDL doc). Toplu restore'da throttle.

---

## 15. PoC script'leri ve test edilmiş örnek komutlar

Konum: `~/Project/ipws-restore/poc/python/`. **Bağımlılık yok — sadece Python stdlib** (`urllib`, `xml.etree.ElementTree`). Hepsi `IPWS_USER` / `IPWS_PASS` env override'ı destekler; `IPWS_HOST` ile host/IP override.

| Script | İşlev | Sınıf |
|---|---|---|
| `ipws_get_children.py` | `GetChildren` — folder tree (recursive değil, `--depth` ile client-side recursion) | read-only |
| `ipws_search.py` | `Search` — server-side recursive arama (type/name/date filtre) | read-only |
| `ipws_lookup.py` | Search → MOB-dedup → GetAttributes; tüm özellikleri döker (operatör aracı) | read-only |
| `ipws_check_ready.py` | `CheckSequenceIsReadyForXfer/MixDown` + **preflight** (side-effect kontrolü) | read-only |
| `ipws_readiness.py` | A/B/C state teşhisi (DC + `.transfer` companion mantığı) | read-only |
| `ipws_restore_submit.py` | `SubmitJobUsingProfile` (default **dry-run**) + `GetJobStatus` | ⚠️ submit = mutating |

### 15.1 Kurulum / kimlik

```bash
# Kalıcı DNS yoksa IP bypass:
export IPWS_HOST="http://ipws-host.example.local"

# Kimlik (hardcoded default'a güvenme — rotate edilecek):
export IPWS_USER="Presenter01"
export IPWS_PASS="Avid2019"      # read-only test kullanıcısı (rotate edilecek)
# veya: poc/python/.env.example -> .env kopyala, set -a; source .env; set +a
```

### 15.2 Folder tree — `ipws_get_children.py`

```bash
# Kök sistem klasörleri (6 adet):
python3 poc/python/ipws_get_children.py --uri "interplay://BSVMWG/"

# Projects altı (21 üretim klasörü):
python3 poc/python/ipws_get_children.py --uri "interplay://BSVMWG/Projects/"

# 2 seviye derinlik + ham SOAP cevabı (debug):
python3 poc/python/ipws_get_children.py --uri "interplay://BSVMWG/Projects/" --depth 2 --raw
```

### 15.3 Server-side search — `ipws_search.py`

```bash
# DC003617 ile başlayanlar (NOT: BeginsWith reddedilir; script default'u --name-cond=BeginsWith,
# çalışan değer Contains/Equals — name-cond'u override et):
python3 poc/python/ipws_search.py \
    --root "interplay://BSVMWG/Projects/" \
    --name-prefix "DC0003617" \
    --type sequence \
    --name-cond Contains \
    --max 200

# Ham request+response görmek için:
python3 poc/python/ipws_search.py --root "interplay://BSVMWG/" --name-prefix "DC003617" --name-cond Contains --raw
```

### 15.4 Operatör lookup — `ipws_lookup.py` (en çok kullanılan)

```bash
# DC numarasıyla (Display Name Contains, default):
python3 poc/python/ipws_lookup.py DC00036170

# Bir maç serisinin tamamı (prefix):
python3 poc/python/ipws_lookup.py DC0003617 --max 20

# Video ID ile tam eşleşme (production playlist kalıbı):
python3 poc/python/ipws_lookup.py M_KOREN_MANISA_37H_1D --by video_id --cond Equals

# Video ID prefix (Contains):
python3 poc/python/ipws_lookup.py M_KOREN_MANISA --by video_id

# Belirli kök + son 7 gün (since client-side filtrelenmeli; server-side date çalışmıyor):
python3 poc/python/ipws_lookup.py DC00036170 --root "interplay://BSVMWG/Projects/01   MAC/"
```

### 15.5 Readiness check + preflight — `ipws_check_ready.py`

```bash
# Tek sequence, preflight ile (Modified Date/By önce-sonra karşılaştırır, değişirse ABORT):
IPWS_HOST="http://ipws-host.example.local" python3 poc/python/ipws_check_ready.py DC00036170

# Video ID ile:
python3 poc/python/ipws_check_ready.py M_KOREN_MANISA_37H_1D --by video_id --cond Equals

# Preflight bir kez geçtiyse, tekrar koşularda atla:
python3 poc/python/ipws_check_ready.py DC0003617 --max 20 --skip-preflight
```

### 15.6 A/B/C state teşhisi — `ipws_readiness.py`

```bash
# Bir maç serisinin tamamı için STP-hazırlık state'i (DC + .transfer companion):
python3 poc/python/ipws_readiness.py DC0003617 --max 20

# Tek sekans tam eşleşme:
python3 poc/python/ipws_readiness.py DC00036170_KOREN_MANISA_37H_1D --cond Equals
```

### 15.7 Restore submit (⚠️ mutating, onaylı istisna) — `ipws_restore_submit.py`

```bash
# DRY-RUN (default — hiçbir şey göndermez, parola maskelenmiş envelope'u basar):
python3 poc/python/ipws_restore_submit.py --uri 'interplay://BSVMWG?mobid=...'

# GERÇEK submit (yalnızca açık onayla — Partial default):
python3 poc/python/ipws_restore_submit.py --uri 'interplay://BSVMWG?mobid=...' --execute

# Full restore profili ile:
python3 poc/python/ipws_restore_submit.py --uri 'interplay://BSVMWG?mobid=...' \
    --profile 'BeINSports -Full Restore' --execute --polls 3 --interval 5

# Var olan job'u izle (read-only, submit yok):
python3 poc/python/ipws_restore_submit.py --status 'interplay://BSVMWG/DMS?jobid=...'
```

### 15.8 Test edilmiş veri seti (referans)

`DC00036170`–`DC00036175` (TFF 1. Lig 37. hafta), 6/6 bulundu:

| Sequence | Maç | Devre |
|---|---|---|
| DC00036170_KOREN_MANISA_37H_1D | Korenspor–Manisa | 1 |
| DC00036171_KOREN_MANISA_37H_2D | Korenspor–Manisa | 2 |
| DC00036172_ERZ_BANDIRMA_37H_1D | Erzurumspor–Bandırma | 1 |
| DC00036173_ERZ_BANDIRMA_37H_2D | Erzurumspor–Bandırma | 2 |
| DC00036174_PENDIK_BOLU_37H_1D | Pendikspor–Boluspor | 1 |
| DC00036175_PENDIK_BOLU_37H_2D | Pendikspor–Boluspor | 2 |

---

## 16. Kopyalanabilir SOAP envelope'ları (referans)

> Tüm envelope'larda kimlik bilgisini gerçeğiyle değiştir. `s:`=Envelope, `a:`/`types:`=assets, `t:`=transfer, `j:`=jobs, `c:`=assets-credentials.

### 16.1 GetChildren (Assets)
```xml
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:types="http://avid.com/interplay/ws/assets/types">
  <soapenv:Header>
    <types:UserCredentials>
      <types:Username>Presenter01</types:Username>
      <types:Password>Avid2019</types:Password>
    </types:UserCredentials>
  </soapenv:Header>
  <soapenv:Body>
    <types:GetChildren>
      <types:InterplayURI>interplay://BSVMWG/Projects/</types:InterplayURI>
      <types:IncludeFolders>true</types:IncludeFolders>
      <types:IncludeFiles>false</types:IncludeFiles>
      <types:IncludeMOBs>false</types:IncludeMOBs>
    </types:GetChildren>
  </soapenv:Body>
</soapenv:Envelope>
```

### 16.2 Search (Assets)
```xml
<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:types="http://avid.com/interplay/ws/assets/types">
  <soapenv:Header>
    <types:UserCredentials>
      <types:Username>Presenter01</types:Username>
      <types:Password>Avid2019</types:Password>
    </types:UserCredentials>
  </soapenv:Header>
  <soapenv:Body>
    <types:Search>
      <types:InterplayPathURI>interplay://BSVMWG/Projects/</types:InterplayPathURI>
      <types:SearchGroup Operator="AND">
        <types:AttributeCondition Condition="Equals">
          <types:Attribute Name="Video ID" Group="USER">M_KOREN_MANISA_37H_1D</types:Attribute>
        </types:AttributeCondition>
        <types:AttributeCondition Condition="Equals">
          <types:Attribute Name="Type" Group="SYSTEM">sequence</types:Attribute>
        </types:AttributeCondition>
      </types:SearchGroup>
      <types:MaxResults>50</types:MaxResults>
    </types:Search>
  </soapenv:Body>
</soapenv:Envelope>
```

### 16.3 GetAttributes (Assets)
```xml
<soapenv:Body>
  <types:GetAttributes>
    <types:InterplayURIs>
      <types:InterplayURI>interplay://BSVMWG?mobid=...</types:InterplayURI>
    </types:InterplayURIs>
  </types:GetAttributes>
</soapenv:Body>
```

### 16.4 CheckSequenceIsReadyForXfer (Transfer) — credentials namespace tuzağına dikkat
```xml
<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:t="http://avid.com/interplay/ws/transfer/types"
            xmlns:c="http://avid.com/interplay/ws/assets/types">
  <s:Header>
    <c:UserCredentials>
      <c:Username>Presenter01</c:Username>
      <c:Password>Avid2019</c:Password>
    </c:UserCredentials>
  </s:Header>
  <s:Body>
    <t:CheckSequenceIsReadyForXfer>
      <t:InterplayURI>interplay://BSVMWG?mobid=...</t:InterplayURI>
      <!-- opsiyonel: <t:TargetResolution>...</t:TargetResolution> -->
    </t:CheckSequenceIsReadyForXfer>
  </s:Body>
</s:Envelope>
```
(`CheckSequenceIsReadyForMixDown` aynı yapı, sadece op adı değişir.)

### 16.5 SubmitJobUsingProfile (Jobs) — ⚠️ mutating
```xml
<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            xmlns:j="http://avid.com/interplay/ws/jobs/types"
            xmlns:c="http://avid.com/interplay/ws/assets/types">
  <s:Header>
    <c:UserCredentials>
      <c:Username>Presenter01</c:Username>
      <c:Password>Avid2019</c:Password>
    </c:UserCredentials>
  </s:Header>
  <s:Body>
    <j:SubmitJobUsingProfile>
      <j:Service>com.avid.dms.restore</j:Service>
      <j:Profile>BeINSports - Partial Restore</j:Profile>
      <j:InterplayURI>interplay://BSVMWG?mobid=...</j:InterplayURI>
      <j:SourceServerType>Assets</j:SourceServerType>
    </j:SubmitJobUsingProfile>
  </s:Body>
</s:Envelope>
```

### 16.6 GetJobStatus (Jobs) — read-only
```xml
<s:Body>
  <j:GetJobStatus>
    <j:JobURIs><j:JobURI>interplay://BSVMWG/DMS?jobid=...</j:JobURI></j:JobURIs>
  </j:GetJobStatus>
</s:Body>
```

### 16.7 GetProfiles (Jobs) — Services child = `<Name>`
```xml
<s:Body>
  <j:GetProfiles>
    <j:WorkgroupURI>interplay://BSVMWG</j:WorkgroupURI>
    <j:Services><j:Name>com.avid.dms.restore</j:Name></j:Services>
    <j:ShowParameters>true</j:ShowParameters>
  </j:GetProfiles>
</s:Body>
```

### 16.8 SendToPlayback (Transfer) — ⚠️ yasaklı/keşif
Bkz. §13.1 — `TransferEngineHostName` + `InterplayURI` (.transfer) + `DestinationPlaybackDevice` + `Priority` + `Overwrite`.

---

## 17. WSDL / XSD kaynakları (repo'da)

`~/Project/ipws-restore/poc/wsdl/` altında 13 dosya (Faz 1'de indirildi):

```
Assets.wsdl (57.9 KB)      assets.xsd (95.8 KB)        common.xsd (11.1 KB — SearchGroup, AttributeCondition, ErrorType, UserCredentials)
Archive.wsdl               archive__archive.xsd
Transfer.wsdl              transfer__transfer.xsd
Jobs.wsdl                  jobs__jobs.xsd
Infrastructure.wsdl        infrastructure__infrastructure.xsd
UserManagement.wsdl        usermanagement__user.xsd
```

- `common.xsd` → `targetNamespace = .../assets/types` (UserCredentials, ErrorType, ErrorListType, ExtensionType burada — bu yüzden credentials assets ns'inde).
- `ErrorType`: `Code` (zorunlu attr) + `Message` + `Details` + opsiyonel `InterplayURI`.
- `JobStatusType`: `JobURI` + `Status` (string) + opsiyonel `PercentComplete` (int).
- `SubmitJobUsingProfileType`: Service, Profile, InterplayURI, opsiyonel SourceServerType (XSD: "Archive ve Assets (default)" — saha Assets).
- `SendToPlaybackType`: TransferEngineHostName, InterplayURI, DestinationPlaybackDevice, Priority (default NORMAL), Overwrite (opsiyonel bool).

---

## 18. Güvenlik notları (entegrasyondan önce kapat)

⚠️ Aşağıdakiler PoC sırasında açığa çıktı, **yandı sayılır**:

1. **`Presenter01` parolası `Avid2019`** — Avid admin'e rotate ettir.
2. **Hardcoded credentials** `poc/python/ipws_*.py` içinde (`DEFAULT_PASSWORD`) — production'a geçmeden sil, **env-only** davranışa dön.
3. **Workstation sudo parolası** — chat'e yapıştırıldı, `passwd` ile değiştir.
4. **Bash history temizliği:** `history | grep -E '1Q2w3e4r|Avid2019'` → eşleşeni `history -d <no>; history -w`.
5. **Production servis hesabı:** PoC `Presenter01` yerine ayrı, sınırlı yetkili `svc-readiness-monitor` gibi bir hesap; servis bazında izinlendirme + auth log.

---

## 19. Bilinmeyenler / açık sorular (entegrasyonu etkileyen)

### Teknik (test/araştırma gerekir)
- **Date condition string** — `GreaterThanEquals` reddedildi; doğrusu (`GreaterThan`/`GE`/`GreaterThanOrEqualTo`?) bilinmiyor. Şimdilik client-side tarih filtrele.
- **`GetLatest`** checkout/lock yapıyor mu — test edilmedi, production'da kullanma.
- **GUI-tetikli restore** (Media Composer) `Jobs.GetJobStatus` queue'sunda görünür mü — IPWS-submit görünüyor, GUI ayrı, doğrulanmadı.
- **DC-Xfer `OTHER_ERROR` kökü** — pratikte `.transfer` üzerinden okunarak aşıldı; kök sebep teyit edilmedi.
- **IPWS 6-servis dışı endpoint** (PSE, Media Services WS, custom) — probe edilmedi.

### Operasyon ekibi teyidi bekleyen (docs/02)
1. `.transfer` suffix'li sequence kanonik yayın versiyonu mu? (empirik destekli, teyit değerli)
2. Mixdown ne zaman/kim tarafından alınıyor (manuel mi otomatik mi, tetikleyici)?
3. Yayın havuzu hangi sistem (Spectrum/AirSpeed/K2/iTX/Pebble/...)? Ağ, port, API, auth, eşleşme ID?
4. Playlist'ten gelen Video ID formatı (tam string mi, varyasyon var mı, `M_` prefix)?
5. Avid'de Video ID eşleşmesi case-sensitive mi olmalı (normalize edelim mi)?

### Belge talebi (IT/sysadmin)
- **IPWS sunucusundaki SDK `Doc\` klasörü** — Programmer's Reference HTML (status enum, rate limit, tam op semantiği burada; ayrı PDF yok).
- **Saha IPWS versiyonu** — `Infrastructure.GetVersionInformation` ile oku.
- DIVA 9.0 Avid Connectivity Guide (AWD mimari referansı).

---

## 20. Entegrasyon mimarisi — öneri (sonraki faz)

PoC = stdlib Python script'leri. Production monitor için minimum entegrasyon iskeleti:

```
[Playlist/Rundown kaynağı]
        │  (Video ID listesi)
        ▼
[Readiness Monitor servisi]  ── IPWS SOAP (read-only) ──►  ipws-host
        │   1. Search(Video ID, Group=USER, Equals)  → DC + .transfer bul (MOB-dedup)
        │   2. GetAttributes                          → metadata
        │   3. .transfer CheckSequenceIsReadyForXfer  → otoriter readiness
        │   4. (yoksa) DC CheckSequenceIsReadyForMixDown → A/B/C state
        ▼
[READY / MISSING / NEEDS-MIXDOWN / COLD raporu]  → dashboard / API / alarm
        (eylem YOK — restore/STP operatör veya başka sistem)
```

- Karar değişkeni: **state (A/B/C)**, `Media Status` değil.
- Mimari seçim (FastAPI+Python vs ASP.NET Core) ve UI henüz açık (BACKLOG).
- Read-only kalıcı kural; submit yeteneği eklenecekse açık onay + ayrı yetki.

---

## Ek: bu raporun kaynak haritası (repo)

| Repo dosyası | Bu rapordaki karşılığı |
|---|---|
| `CLAUDE.md` | §1, §2, §8, §14 (proje kuralları) |
| `docs/01-poc-rapor-2026-04-27.md` | §2, §7, §8, §9 (Faz 1: bağlantı, search, keşif) |
| `docs/02-operasyon-sorulari.md` | §19 (op teyidi bekleyen 5 soru) |
| `docs/03-readiness-preflight-2026-05-20.md` | §10.2 (read-only kanıtı), §10.6 (ilk state) |
| `docs/04-restore-transfer-2026-05-20.md` | §1.3, §11, §12, §13 (tam zincir) |
| `docs/reference/ipws-api-inventory.md` | §6 (76 op envanteri) |
| `BACKLOG.md` | §18, §19 (açık kalemler, güvenlik) |
| `poc/python/*.py` | §15, §16 (script'ler, örnek komut/envelope) |
| `poc/wsdl/*` | §5, §17 (namespace, şema) |

---

*Bu belge `~/Project/ipws-restore` reposundaki tüm dökümanların, test edilmiş script'lerin ve canlı bulguların (2026-04-27 ve 2026-05-20 oturumları) tek-belge konsolidasyonudur. Kanıt seviyeleri etiketlidir; entegrasyonda [DOĞRULANDI] olanlara güven, [WSDL]/[HİPOTEZ] olanları kendi ortamında bir kez doğrula.*
