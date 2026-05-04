# BCMS TLS Internal CA — Operatör Kılavuzu

> **Bu dizin BCMS-internal Certificate Authority infrastructure'ını içerir.**
> Tasarım fazı için yerel olarak üretilen 2-tier CA chain (root → intermediate → server cert).
> Production'a geçişte Tekyon kurum CA'sından imzalanmış cert ile değiştirilir.

## Dizin yapısı

```
infra/tls/
├── ca/
│   ├── root.crt              # Root CA (10 yıl, COMMITTED public cert)
│   ├── root.key              # Root CA private key (.gitignore — ASLA commit etme)
│   ├── intermediate.crt      # Intermediate CA (5 yıl, committed)
│   ├── intermediate.csr      # Intermediate CSR (informational, committed)
│   ├── intermediate.key      # Intermediate private key (.gitignore)
│   └── *.srl                 # Serial counter (.gitignore)
├── server/
│   ├── server.crt            # Server cert (2 yıl, committed)
│   ├── server.key            # Server private key (.gitignore)
│   ├── server.csr            # Server CSR (informational, committed)
│   └── server-fullchain.crt  # server.crt + intermediate.crt (nginx için, committed)
├── openssl/
│   ├── root.cnf              # Root CA openssl config
│   ├── intermediate.cnf      # Intermediate CA openssl config
│   └── server.cnf            # Server cert config (SAN listesi burada)
├── scripts/
│   └── generate-ca.sh        # Tek komutla 3 cert üretici
├── .gitignore                # *.key, *.srl ignore
└── README.md                 # Bu dosya
```

## Hızlı başlangıç

### İlk kurulum (cert'ler henüz yoksa)

```bash
cd /path/to/bcms
bash infra/tls/scripts/generate-ca.sh
```

Çıktı:
- `ca/root.crt`, `ca/intermediate.crt`, `server/server.crt` üretilir
- `server/server-fullchain.crt` (server + intermediate concat) hazırlanır
- Chain doğrulaması yapılır

### Container'ı TLS ile çalıştırma

```bash
docker compose up -d --no-build --pull never web keycloak
```

`--no-build --pull never` flag'leri **kritik**: image rebuild ve registry pull tetiklenmemeli (network kuralı).

### Browser'a CA install (her erişen makine için bir kez)

**Chrome / Edge / Brave:**
1. Settings → Privacy and security → Security → Manage certificates → Authorities
2. "Import" → `infra/tls/ca/root.crt` seç
3. ✓ "Trust this certificate for identifying websites"

**Firefox:**
1. Settings → Privacy & Security → Certificates → View Certificates → Authorities
2. Import → `infra/tls/ca/root.crt`
3. ✓ "Trust this CA to identify websites"

**Linux system-wide:**
```bash
sudo cp infra/tls/ca/root.crt /usr/local/share/ca-certificates/bcms-internal-root.crt
sudo update-ca-certificates
```

**Mac system-wide:**
```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  infra/tls/ca/root.crt
```

### Hosts file entry

Her erişen makinede:

```
# Linux/Mac: /etc/hosts
# Windows:   C:\Windows\System32\drivers\etc\hosts

# Aynı makineden erişim
127.0.0.1     beinport

# LAN'daki başka makineden erişim
172.28.204.133  beinport
```

### Test

Browser'dan: `https://beinport/` → yeşil kilit + SPA yüklenmeli.

Komut satırından (CA cert ile):
```bash
curl --cacert infra/tls/ca/root.crt \
     --resolve beinport:443:127.0.0.1 \
     https://beinport/health
```

## Cert validity bilgileri

| Cert | Validity | Algoritma | Hash |
|---|---|---|---|
| Root CA | 10 yıl (3650 gün) | ECDSA secp384r1 | SHA-384 |
| Intermediate CA | 5 yıl (1825 gün) | ECDSA secp384r1 | SHA-384 |
| Server cert | 2 yıl (730 gün) | ECDSA secp384r1 | SHA-384 |

Mevcut server cert validity'sini görmek için:
```bash
openssl x509 -in infra/tls/server/server.crt -noout -dates
```

## Renewal prosedürü

### Server cert renewal (2 yılda bir)

Server cert süresi dolarsa veya SAN listesi değişirse:

```bash
# 1. Eski server cert'i kaldır
rm infra/tls/server/server.{crt,key,csr}
rm infra/tls/server/server-fullchain.crt

# 2. Yeni cert üret (intermediate ile imzalanır, root değişmez)
bash infra/tls/scripts/generate-ca.sh

# 3. Container restart
docker compose restart web

# 4. Verify
curl --cacert infra/tls/ca/root.crt \
     --resolve beinport:443:127.0.0.1 \
     https://beinport/health
```

Browser'da CA değişmediği için tekrar install gerekmez.

### Intermediate CA renewal (5 yılda bir)

```bash
# 1. Intermediate ve server cert'i kaldır
rm infra/tls/ca/intermediate.{crt,key,csr}
rm infra/tls/ca/*.srl
rm infra/tls/server/server.{crt,key,csr}
rm infra/tls/server/server-fullchain.crt

# 2. Üret
bash infra/tls/scripts/generate-ca.sh

# 3. Container restart
docker compose restart web
```

Root değişmediği için browser CA install tekrar gerekmez.

### Root CA renewal (10 yılda bir)

Major operasyon — tüm chain yeniden üretilir, browser'larda CA tekrar install gerekir.

```bash
# 1. Tüm cert'leri sil
rm -rf infra/tls/ca/* infra/tls/server/*

# 2. Üret
bash infra/tls/scripts/generate-ca.sh

# 3. Yeni root.crt'yi tüm erişen makinelerin browser'larına install et
# 4. Container restart
docker compose restart web
```

## SAN listesi değiştirme

Yeni hostname/IP eklemek için:

```bash
# 1. Edit infra/tls/openssl/server.cnf — [alt_names] bölümünü güncelle
nano infra/tls/openssl/server.cnf

# 2. Sadece server cert'i yeniden üret
rm infra/tls/server/server.{crt,key,csr}
rm infra/tls/server/server-fullchain.crt
bash infra/tls/scripts/generate-ca.sh

# 3. Container restart
docker compose restart web

# 4. Verify SAN
openssl x509 -in infra/tls/server/server.crt -text -noout | grep -A 1 "Subject Alternative Name"
```

## Troubleshooting

### "ERR_CERT_AUTHORITY_INVALID" (browser)
- Root CA browser'a install edilmemiş. Yukarıdaki "Browser'a CA install" adımlarını uygula.

### "ERR_NAME_NOT_RESOLVED"
- Hosts file entry yok. `/etc/hosts` veya Windows `hosts`'a ekle.

### "ERR_CONNECTION_REFUSED"
- Container çalışmıyor: `docker compose ps` kontrol et.
- nginx config syntax hatası: `docker exec bcms_web nginx -t` çalıştır.

### nginx config test
```bash
docker exec bcms_web nginx -t
```

### Cert chain doğrulama
```bash
openssl verify -CAfile infra/tls/ca/root.crt \
               -untrusted infra/tls/ca/intermediate.crt \
               infra/tls/server/server.crt
```

### TLS handshake debug
```bash
docker exec bcms_web sh -c "echo | openssl s_client -connect localhost:443 -servername beinport 2>&1 | head -30"
```

## Production'a geçiş

Tasarım fazından production'a geçişte:
- BCMS local CA atılır
- Tekyon kurum CA'sından yeni cert imzalanır
- DNS server'a A record + CNAME eklenir (Tekyon IT)
- AD GPO ile CA dağıtımı yapılır

Detaylar: `ops/REQUIREMENTS-TLS-PRODUCTION-TRANSITION.md`

## Network güvenlik notu

CA üretimi (`generate-ca.sh`) **tamamen offline** çalışır — `openssl` lokal hesaplama yapar, hiçbir network paketi göndermez. Container restart `docker compose up -d --no-build --pull never` ile network operasyonu olmadan tamamlanır. Browser test'i kullanıcının kendi makinesinden yapılır.

## References

- `ops/REQUIREMENTS-TLS-INTERNAL-CA.md` — design dokümanı
- `ops/REQUIREMENTS-TLS-PRODUCTION-TRANSITION.md` — production planlama
- `BCMS_ULTRA_DETAILED_AUDIT_REPORT_2026-05-01.md` Section 12 — CRIT-001/002 closure
