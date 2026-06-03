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
(sunucu IP'si **172.28.204.96**):

- **Windows:** `C:\Windows\System32\drivers\etc\hosts` (Not Defteri'ni *yönetici* aç)
- **Ubuntu/Linux:** `/etc/hosts` (`sudo`)

```
172.28.204.96   beinport
```

> hosts satırı eklemek istemezsen doğrudan **`https://172.28.204.96`** de açabilirsin — sertifika SAN'ı
> hem `beinport` hem `172.28.204.96` içerir.

---

## 1. Windows kurulumu (Chrome → Windows sertifika deposu)

Chrome, Windows'ta sistem sertifika deposunu kullanır. Kök sertifikayı **"Güvenilen Kök Sertifika
Yetkilileri"** deposuna eklemek yeterli.

**Yöntem A — Çift tıkla (en kolay):**
1. `bcms-root-ca.cer` dosyasına çift tıkla → **Sertifikayı Yükle**.
2. Konum: **Yerel Makine** (tüm kullanıcılar) → İleri *(yönetici onayı ister)*.
3. **Tüm sertifikaları aşağıdaki depoda sakla** → **Gözat** → **Güvenilen Kök Sertifika Yetkilileri** → Tamam.
4. İleri → Son.

**Yöntem B — PowerShell (yönetici):**
```powershell
Import-Certificate -FilePath .\bcms-root-ca.cer -CertStoreLocation Cert:\LocalMachine\Root
```

**Yöntem C — certutil (yönetici cmd):**
```cmd
certutil -addstore -f Root bcms-root-ca.cer
```

➡️ Kurulumdan sonra **Chrome'u tamamen kapatıp aç**. `https://beinport` artık kilit simgesiyle açılır.

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

1. Chrome'da `https://beinport` (veya `https://172.28.204.96`) aç.
2. Adres çubuğunda **kilit** simgesi olmalı, "Güvenli değil" uyarısı OLMAMALI.
3. Kilit → sertifika → **Veren (Issuer): BCMS Internal Intermediate CA**, kök **BCMS Internal Root CA**;
   parmak izi yukarıdaki SHA-256 ile aynı olmalı.

## Sık sorunlar
- **Hâlâ uyarı var:** Chrome tam kapanmadı (arka planda açık). `chrome://restart` ya da tüm pencereleri kapat.
- **`ERR_CERT_COMMON_NAME_INVALID`:** Adresi SAN'da olmayan bir isimle açıyorsun. Yalnız `beinport`,
  `localhost`, `127.0.0.1`, `172.28.204.96` geçerli.
- **Ubuntu'da kurdum ama olmuyor:** Muhtemelen sadece sistem deposuna (A) eklendi; Chrome için **B (NSS)**
  adımı şart.

---
*Üretim/yenileme: `infra/tls/scripts/generate-ca.sh` · SAN tanımı: `infra/tls/openssl/server.cnf` ·
Server cert geçerlilik: 2026-06-03 → 2028-06-02 · Root CA: 2036'ya kadar.*
