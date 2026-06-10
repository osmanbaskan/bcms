# beINport — Chrome Sertifika Kurulumu (Ubuntu + Windows)

beINport web arayüzü (`https://beinport`) **BCMS Internal Root CA** ile imzalı bir sertifika kullanır.
Chrome'un "Güvenli değil" uyarısı vermemesi için her client makineye bu **kök sertifikayı** bir kez
kurmak yeterlidir. Sunucuda bir şey yapmaya gerek yok.

## Bu klasördeki dosyalar
| Dosya | Kodlama | Nerede |
|-------|---------|--------|
| `bcms-root-ca.crt` | PEM | Ubuntu (ve istenirse Windows) |
| `bcms-root-ca.cer` | DER | Windows (çift-tıkla kurulum kolaylığı) |

> İkisi de **aynı kök sertifikadır**, sadece kodlama farklı. Bu yalnızca **public** kök sertifikadır —
> özel anahtar (`root.key`) ASLA dağıtılmaz.

**Doğrulama — SHA-256 parmak izi:**
`E0:EC:48:59:9C:47:98:3D:4D:68:0D:F0:D1:DD:A8:57:D0:5C:AD:25:7B:0F:7E:E5:88:44:61:5C:A0:77:53:69`

---

## 0. Ön koşul — erişim adresi (her iki OS)

beINport'a **`https://beinport`** ile erişeceksen, client'ın hosts dosyasına şu satırı ekle
(sunucu IP'si **server.example.local**):

- **Windows:** `C:\Windows\System32\drivers\etc\hosts` (Not Defteri'ni *yönetici* aç)
- **Ubuntu/Linux:** `/etc/hosts` (`sudo`)

```
server.example.local   beinport
```

> hosts satırı eklemek istemezsen doğrudan **`https://server.example.local`** de açabilirsin — sertifika SAN'ı
> hem `beinport` hem `server.example.local` içerir.

---

## 1. Windows kurulumu (Chrome → Windows sertifika deposu)

Chrome, Windows'ta sistem sertifika deposunu kullanır. Kök sertifikayı **"Güvenilen Kök Sertifika
Yetkilileri"** deposuna eklemek yeterli.

> ⚠️ **EN SIK HATA:** `.cer`'e çift tıklayıp Windows'un **depoyu otomatik seçmesine** izin vermek —
> kök sertifikayı "Güvenilen Kök" yerine yanlış depoya (Personal/Other) koyar ve Chrome **yine uyarır**.
> Doğru depo: **"Güvenilen Kök Sertifika Yetkilileri" (Trusted Root Certification Authorities)**.

**Yöntem A — `kur-bcms-ca.bat` (tek tık · ÖNERİLEN):** doğru depoya zorla kurar.
1. `kur-bcms-ca.bat` dosyasına **sağ tık → "Yönetici olarak çalıştır"**.
2. "[OK] … kuruldu" mesajını gör → bir tuşa bas.
3. **Chrome'u tamamen kapatıp aç** (`chrome://restart`).

**Yöntem B — certutil (yönetici cmd):**
```cmd
certutil -addstore -f Root bcms-root-ca.cer
```

**Yöntem C — PowerShell (yönetici):**
```powershell
Import-Certificate -FilePath .\bcms-root-ca.cer -CertStoreLocation Cert:\LocalMachine\Root
```

**Yöntem D — Çift tıkla (elle, depoya DİKKAT):**
1. `bcms-root-ca.cer` → çift tık → **Sertifikayı Yükle**.
2. Konum: **Yerel Makine** → İleri *(yönetici onayı)*.
3. **Tüm sertifikaları aşağıdaki depoda sakla** → **Gözat** → **Güvenilen Kök Sertifika Yetkilileri** → Tamam. *(otomatik seçme!)*
4. İleri → Son.

➡️ Her yöntemde, kurulumdan sonra **Chrome'u tamamen kapatıp aç**. `https://beinport` artık kilit simgesiyle açılır.

---

## 2. Ubuntu kurulumu (Chrome → NSS veritabanı)

⚠️ Linux'ta Chrome/Chromium sistem deposunu değil **kendi NSS veritabanını** (`~/.pki/nssdb`) kullanır.
Bu yüzden iki adım var: (A) sistem deposu — `curl`/diğer araçlar için, (B) NSS — **Chrome için şart**.

Önce araç:
```bash
sudo apt install -y libnss3-tools ca-certificates
```

**A) Sistem deposu (genel güven):**
```bash
sudo cp bcms-root-ca.crt /usr/local/share/ca-certificates/bcms-root-ca.crt
sudo update-ca-certificates
```

**B) Chrome NSS deposu (Chrome için zorunlu) — kullanıcı olarak (sudo'suz):**
```bash
mkdir -p "$HOME/.pki/nssdb"
certutil -d sql:"$HOME/.pki/nssdb" -A -n "BCMS Internal Root CA" -t "C,," -i bcms-root-ca.crt
# doğrula:
certutil -d sql:"$HOME/.pki/nssdb" -L | grep BCMS
```
> Birden çok kullanıcı varsa B adımını her kullanıcı kendi oturumunda çalıştırmalı.

➡️ Sonra **Chrome'u tamamen kapat** (`pkill chrome` veya menüden çık) ve yeniden aç.

---

## 3. Doğrulama

1. Chrome'da `https://beinport` (veya `https://server.example.local`) aç.
2. Adres çubuğunda **kilit** simgesi olmalı, "Güvenli değil" uyarısı OLMAMALI.
3. Kilit → sertifika → **Veren (Issuer): BCMS Internal Intermediate CA**, kök **BCMS Internal Root CA**;
   parmak izi yukarıdaki SHA-256 ile aynı olmalı.

## Sık sorunlar
- **Windows'ta hâlâ "Güvenli değil":** Büyük ihtimalle kök **yanlış depoda**. Kontrol:
  `certutil -store Root "BCMS Internal Root CA"` (yönetici cmd) → çıktı veriyorsa doğru depoda demektir.
  Yoksa **Yöntem A (.bat)** ile yeniden kur.
- **Hâlâ uyarı (depo doğru):** Chrome tam kapanmadı. `chrome://restart`. Eski hata önbelleğe takıldıysa
  `chrome://net-internals/#hsts` → "Delete domain security policies" → `beinport`.
- **`ERR_CERT_COMMON_NAME_INVALID` / `…_AUTHORITY_INVALID`:** Adresi SAN'da olmayan bir isim/IP ile
  açıyorsun. Geçerli adresler: **`beinport`**, `localhost`, `127.0.0.1`, **`172.28.204.96`**.
  Başka bir IP/isim kullanıyorsan sistem yöneticisine söyle — SAN'a eklenip cert yenilenmeli.
- **Ubuntu'da kurdum ama olmuyor:** Muhtemelen sadece sistem deposuna (A) eklendi; Chrome için **B (NSS)**
  adımı şart.

---
*Üretim/yenileme: `infra/tls/scripts/generate-ca.sh` · SAN tanımı: `infra/tls/openssl/server.cnf` ·
Server cert geçerlilik: 2026-06-10 → 2028-09-12 · Root CA: 2036'ya kadar · SAN: beinport, localhost,
127.0.0.1, 172.28.204.96.*
