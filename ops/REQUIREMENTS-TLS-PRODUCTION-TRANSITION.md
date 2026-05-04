# BCMS TLS Production Transition — Tasarım Dokümanı

> **Tarih:** 2026-05-04
> **Durum:** Planlama — production deployment hazır olduğunda uygulanır
> **Bağımlı:** `ops/REQUIREMENTS-TLS-INTERNAL-CA.md` (design fazı, BCMS local CA)
> **Scope:** Tasarım fazından production'a geçişte TLS ve domain altyapısının olgunlaşması
> **Önemli not:** Bu doküman **placeholder'lar içerir**: `<MAIN_DOMAIN>`, `<SUBDOMAIN>`, `<BCMS_HOST_IP>`. Production planlama aşamasında doldurulacak.

---

## 1. Bağlam ve Hedef

### 1.1 Mevcut durum (design fazı)
- BCMS local CA chain (root + intermediate + 2-yıl server cert)
- nginx TLS termination, port 80→443 redirect
- Hostname: `beinport` (single-label, hosts file ile)
- Erişim: 1-2 design fazı makinesi, hosts file her birinde
- Tek FQDN cert SAN: `beinport`, `localhost`, `127.0.0.1`, `172.28.204.133`

### 1.2 Hedef durum (production)
- Tekyon kurum CA (veya commercial CA) tarafından imzalı server cert
- Tekyon DNS server'da kayıt (A + opsiyonel CNAME + opsiyonel PTR)
- Hem subdomain hem main domain cihazlarından erişim
- AD GPO ile otomatik CA dağıtımı (tüm forest)
- Multi-FQDN cert SAN

### 1.3 Korunacak unsurlar (mimari değişmez)
- nginx reverse proxy mimarisi
- TLS termination at edge
- Path-based routing (`/api/v1/`, `/realms/`, `/`)
- Keycloak `KC_PROXY=edge`
- Security headers (HSTS, CSP, X-Frame, vb.)

**Production transition bir cert/config swap'tir, mimari refactor değil.**

---

## 2. Tekyon Network Yapısı (kullanıcı dolduracak)

### 2.1 Domain bilgileri

| Alan | Değer | Örnek |
|---|---|---|
| Main domain (parent) | `<MAIN_DOMAIN>` | `tekyon.local`, `tekyon.com.tr`, `tekyon.lan` |
| Subdomain (BCMS host'u burada) | `<SUBDOMAIN>` | `broadcast`, `mcr`, `yayin` |
| Full subdomain FQDN | `<SUBDOMAIN>.<MAIN_DOMAIN>` | `broadcast.tekyon.local` |
| BCMS host'un FQDN'i | `beinport.<SUBDOMAIN>.<MAIN_DOMAIN>` | `beinport.broadcast.tekyon.local` |
| BCMS host'un IP'si | `<BCMS_HOST_IP>` | `172.28.204.133` (production'da değişebilir) |

### 2.2 AD/DNS yapısı (kullanıcı netleştirecek)

| Soru | Cevap (kullanıcı dolduracak) |
|---|---|
| AD forest mı, standalone mı? | `<FOREST_OR_STANDALONE>` |
| DNS server türü? | `<DNS_SERVER_TYPE>` (Windows DNS Server / BIND / başka) |
| DHCP option 119 (DNS search list) push'lanıyor mu? | `<YES_OR_NO>` |
| Tekyon kurum CA mevcut mu? | `<YES_OR_NO>` |
| (Varsa) Tekyon CA'nın yapı türü? | `<CA_INFRASTRUCTURE>` (Windows AD CS / ejbca / başka) |

---

## 3. DNS Konfigürasyonu

### 3.1 Subdomain DNS server'a ekleme

```
; DNS zone: <SUBDOMAIN>.<MAIN_DOMAIN>
beinport    IN    A      <BCMS_HOST_IP>
beinport    IN    AAAA   <BCMS_HOST_IPv6>      ; opsiyonel
```

Reverse DNS:
```
; Reverse zone: <reverse-of-IP>.in-addr.arpa
<host-octet>    IN    PTR    beinport.<SUBDOMAIN>.<MAIN_DOMAIN>.
```

**Etki:** Subdomain cihazları `beinport.<SUBDOMAIN>.<MAIN_DOMAIN>` ile veya kısa `beinport` ile (search domain ile) erişebilir.

### 3.2 Main domain DNS server'a ekleme (cross-domain erişim için)

```
; DNS zone: <MAIN_DOMAIN>
beinport    IN    CNAME    beinport.<SUBDOMAIN>.<MAIN_DOMAIN>.
```

**Etki:** Main domain cihazları `beinport.<MAIN_DOMAIN>` ile veya kısa `beinport` ile erişebilir. CNAME subdomain'e yönlendirir.

### 3.3 DHCP search domain (kısa hostname için)

DHCP server (`Windows DHCP / dnsmasq / ISC DHCP`):

```
# Subdomain scope
DHCP Option 119 (DNS Domain Search List): <SUBDOMAIN>.<MAIN_DOMAIN>, <MAIN_DOMAIN>

# Main domain scope
DHCP Option 119: <MAIN_DOMAIN>
```

**Etki:** Kullanıcı browser'a sadece `beinport` yazınca:
- Subdomain cihazı: önce `beinport.<SUBDOMAIN>.<MAIN_DOMAIN>` denenir → A record bulur
- Main domain cihazı: `beinport.<MAIN_DOMAIN>` denenir → CNAME ile subdomain'e gider

---

## 4. CA Sertifikası Stratejisi

### 4.1 Karar: Yeni cert Tekyon kurum CA'sından

Design fazındaki **BCMS local CA atılır**. Tekyon kurum CA'sından yeni cert imzalattırılır.

**Gerekçe:**
- Forest-level GPO ile zaten dağıtık (tüm cihazlarda kurum CA mevcut)
- Manuel CA install adımı kaldırılır
- Cert lifecycle Tekyon IT prosedürüyle entegre

### 4.2 Yeni cert SAN listesi (production)

Tekyon kurum CA'sından talep edilecek cert için:

```
Subject CN: beinport.<SUBDOMAIN>.<MAIN_DOMAIN>

DNS:
  - beinport.<SUBDOMAIN>.<MAIN_DOMAIN>   (canonical FQDN)
  - beinport.<MAIN_DOMAIN>               (CNAME hedefi, main domain alias)
  - beinport                             (kısa isim, search suffix ile)

IP:
  - <BCMS_HOST_IP>                       (eski URL'ler bookmark'lı kullanıcılar için)
```

### 4.3 Cert lifecycle

- **Validity:** Tekyon IT politikası (genelde 1-2 yıl)
- **Renewal:** Tekyon IT prosedürüne göre (manuel veya otomatik ACME)
- **Revocation:** CRL veya OCSP üzerinden Tekyon CA tarafından
- **Monitoring:** Cert expiry alert (Prometheus + Alertmanager veya kurum monitoring sistemi)

### 4.4 Eğer Tekyon kurum CA yoksa

Alternatif sırası:
1. **Public domain + Let's Encrypt** (BCMS'i public-facing yapmak gerekirse — başka bir tasarım kararı)
2. **Yeni Tekyon-internal CA kur** (BCMS başlatır, IT devralır — büyük iş)
3. **BCMS local CA'yı production'a sürdür** (kabul edilebilir ama profesyonel değil; manuel CA install)

---

## 5. AD Group Policy ile CA Dağıtımı

Eğer Tekyon kurum CA forest-level GPO'da zaten dağıtık ise bu adım atlanır.

Yoksa BCMS-internal CA için:

### 5.1 GPO oluşturma (Active Directory ortamı)

```
Group Policy Management Console → Forest root domain
  → New GPO: "BCMS-CA-Distribution"
  → Computer Configuration
    → Policies
      → Windows Settings
        → Security Settings
          → Public Key Policies
            → Trusted Root Certification Authorities
              → Import: <BCMS root.crt>
```

GPO link: forest root (tüm domain ve subdomain'lere yansır).

### 5.2 Linux/Mac için (AD harici cihaz)

Tekyon'da Linux/Mac kullanan operatörler varsa:
- **Linux:** Configuration management (Ansible/Puppet/Salt) ile `/usr/local/share/ca-certificates/` + `update-ca-certificates`
- **Mac:** MDM (Jamf/Intune) profil ile System Keychain'e add
- **Firefox:** Browser kendi cert store'unu kullanır — ek profil ayarı veya Group Policy for Firefox gerekir

---

## 6. Implementation Checklist

Production'a geçiş için (Tekyon IT ile koordinasyon gerekir):

### Phase 1: Hazırlık (BCMS team, network operasyonu yok)
- [ ] Bu dokümandaki placeholder'lar doldurulur (`<MAIN_DOMAIN>`, vb.)
- [ ] Yeni cert SAN listesi finalize
- [ ] Implementation tarih planlaması (Tekyon IT slot)

### Phase 2: Tekyon IT koordinasyon (network koordinasyonu gerekir, kullanıcı onayı altında)
- [ ] DNS A record talebi: `beinport.<SUBDOMAIN>.<MAIN_DOMAIN> → <BCMS_HOST_IP>`
- [ ] DNS CNAME talebi: `beinport.<MAIN_DOMAIN> → beinport.<SUBDOMAIN>.<MAIN_DOMAIN>`
- [ ] DNS PTR talebi (opsiyonel)
- [ ] Tekyon kurum CA'dan cert talebi (CSR generate, IT'ye ilet)
- [ ] AD GPO ile CA dağıtım (eğer kurum CA yoksa)

### Phase 3: BCMS deployment update
- [ ] `infra/tls/server/server.crt` ve `server-fullchain.crt` Tekyon CA'dan gelen cert ile değiştir
- [ ] `infra/tls/server/server.key` yeni private key ile değiştir
- [ ] `infra/tls/ca/root.crt` ve `intermediate.crt`: Tekyon CA chain'i ile değiştir
- [ ] `.env`: `KC_HOSTNAME=beinport.<SUBDOMAIN>.<MAIN_DOMAIN>`, `BCMS_KEYCLOAK_PUBLIC_URL=https://beinport.<SUBDOMAIN>.<MAIN_DOMAIN>`, `KEYCLOAK_ALLOWED_ISSUERS=https://beinport.<SUBDOMAIN>.<MAIN_DOMAIN>/realms/bcms,...`, `CORS_ORIGIN=...`
- [ ] Frontend `environment.prod.ts`: `keycloak.url = 'https://beinport.<SUBDOMAIN>.<MAIN_DOMAIN>'`
- [ ] `docker compose up -d --no-build web keycloak`
- [ ] Local verify: cert chain (`openssl verify`), TLS handshake, login flow
- [ ] User browser test: production hostname ile bağlantı, network tab'da port yok, yeşil kilit

### Phase 4: Cleanup
- [ ] BCMS local CA atılabilir (artık güvenilen değil)
- [ ] Hosts file kayıtları kaldırılır (DNS resolve ediyor zaten)
- [ ] Dockerfile-baked'e geçiş kararı (volume mount yerine — güvenlik/immutability hedefi)

---

## 7. Risks & Mitigations

| Risk | Olasılık | Etki | Mitigation |
|---|---|---|---|
| DNS değişikliği propagation gecikmesi (TTL) | Orta | Orta | TTL düşük tut (300s), staged rollout |
| Yeni cert + eski cert arası downtime | Düşük | Yüksek | Cert swap restart-only (yeni cert mount + restart); önceden test edilmiş |
| GPO push gecikmesi (yeni cihaz) | Yüksek | Düşük | Manuel CA install talimatı README'de yedek olarak |
| CSR formatı Tekyon CA standartlarıyla uyumsuz | Orta | Yüksek | Phase 1'de IT ile prerequisite check; CSR template paylaş |
| `KC_HOSTNAME_STRICT=true` yeni FQDN'i kabul etmez | Düşük | Yüksek | `.env` güncelleme order: önce `KC_HOSTNAME` ardından restart |
| Cache'lenmiş eski URL (browser, frontend) | Orta | Orta | runtime-config.js cache-control no-store; user browser cache temizleme talimatı |
| Cert renewal otomatik değil → expiry'da downtime | Yüksek | Yüksek | Cert expiry monitoring (Prometheus alert), Tekyon IT renewal SLA |

---

## 8. Production Transition Detayları (kullanıcı dolduracak)

### 8.1 Domain bilgileri (yukarıdaki Section 2.1'den kopyala)

```
MAIN_DOMAIN     = ____________________
SUBDOMAIN       = ____________________
BCMS_HOST_IP    = ____________________
```

### 8.2 Tekyon IT temas noktası

```
İletişim:           ____________________
DNS değişikliği SLA: ____________________
CSR formatı:        ____________________
Cert renewal süreç: ____________________
GPO push sıklığı:   ____________________
```

### 8.3 Onaylanan FQDN listesi (cert SAN'a girer)

```
Canonical FQDN:     ____________________
Main domain alias:  ____________________
Kısa hostname:      beinport (sabit)
LAN IP:             ____________________ (eski URL bookmark'lar için)
```

---

## 9. Implementation Tahmin Tablosu

| İş | Süre |
|---|---|
| Phase 1 (BCMS team, doküman doldurma) | 30 dk - 2 saat |
| Phase 2 (Tekyon IT, DNS + cert) | Tekyon IT SLA bağımlı, tipik 1-3 iş günü |
| Phase 3 (BCMS deployment update) | 1-2 saat (cert swap + restart + verify) |
| Phase 4 (cleanup) | 30 dk |

---

## 10. References

- `ops/REQUIREMENTS-TLS-INTERNAL-CA.md` (design fazı tasarım dokümanı)
- `BCMS_ULTRA_DETAILED_AUDIT_REPORT_2026-05-01.md` Section 12 (CRIT-001/002 kapanışı)
- nginx reverse proxy + Keycloak edge mode pattern (Keycloak official docs)

---

*Bu doküman placeholder'larla yazıldı. Production planlama aşamasında BCMS team + Tekyon IT koordinasyonu ile doldurulup uygulanır. Network operasyonları (DNS, cert, GPO) Tekyon IT tarafından onay altında yapılır.*
