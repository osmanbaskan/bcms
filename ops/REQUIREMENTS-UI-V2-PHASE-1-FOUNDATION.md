# BCMS UI V2 Redesign — Aşama 1: Foundation

> **Tarih:** 2026-05-04
> **Kaynak tasarım:** `/home/ubuntu/website/beINport/`
> **Aşama:** 1 / 3 (Foundation → Pilot → Geri kalan sayfalar)
> **Network politikası:** Tüm implementation lokal. Inter font CDN'i browser tarafından çekilir; CSP zaten Google Fonts izinli (TLS PR'da eklendi).

---

## 1. Hedef

beINport tasarımının **temel katmanını** Angular'a port et:
- Design tokens (renk, tipografi, spacing, shadow, radius)
- App shell (sidebar + header + page header pattern)
- Reusable component'ler (StatusTag, SevTag, Card, KPI, Bar, PageHeader, CommandPalette, AlertPopover, NewBroadcastModal)

Bu, tüm sonraki sayfaların üzerine inşa edileceği **temel katmandır**. Sayfa-bazlı değişiklikler Aşama 2 ve 3'te.

---

## 2. ⛔ KORUMA (memory'de kayıtlı)

`bcms_ui_v2_redesign_scope.md` memory note'undaki KORUMA listesi geçerlidir:
- Export şemaları (Excel/PDF) — **dokunulmaz**
- Studio Plan tablo görünümü — **dokunulmaz** (sadece sayfa shell'i değişir)
- Schedule List kolon başlıkları — **dokunulmaz**
- RBAC / yetkiler / `PERMISSIONS` map — **dokunulmaz**

Aşama 1'de bu kapsamlardan **hiçbirine** dokunulmuyor (foundation katmanı şu kapsamların hiçbirini etkilemez).

---

## 3. Tasarım Kararları

### 3.1 Tipografi

| Font | Kullanım | Kaynak |
|---|---|---|
| **Inter** | Body, UI, default sans | Google Fonts CDN |
| **Inter Tight** | Display (h1, brand, page title) | Google Fonts CDN |
| **JetBrains Mono** | Tarih, port ID, kbd, technical metadata | Google Fonts CDN |

**CSP durumu:** Mevcut CSP `font-src 'self' data: https://fonts.gstatic.com` — Inter ve diğerleri için izinli. Ek değişiklik gerekmez.

### 3.2 Renk paleti

beINport `tokens.css` direkt port edilir:

| Token | Değer | Kullanım |
|---|---|---|
| `--bp-bg-0` | `#1a1b20` | Search, input, en derin |
| `--bp-bg-1` | `#22232a` | App background, header |
| `--bp-bg-2` | `#2d2f36` | Card, dialog (raised) |
| `--bp-bg-3` | `#383a42` | Hover, table header |
| `--bp-purple-500` | `#7c3aed` | Primary action |
| `--bp-purple-300` | `#a78bfa` | Secondary accent, link |
| `--bp-fg-1` | `#f4f4f6` | Default text |
| `--bp-fg-3` | `#8e909c` | Muted, label |
| Sidebar gradient | `#4c1d95 → #2e1065` | Sol sidebar arka plan |

Status renkleri: `live/onair: #ef4444`, `queued: #f59e0b`, `done: #10b981`, `draft: #6b7280`.

### 3.3 Layout boyutları

| Element | Boyut |
|---|---|
| Sidebar genişliği | 248px (sticky, full height) |
| Header yüksekliği | 60px (sticky top, sidebar'a komşu) |
| Page header padding | 24px 32px 16px |
| Body padding | 0 32px 32px |

### 3.4 Sidebar yapısı

Shell.jsx pattern:

**Üst bölüm (6 ana):**
1. Genel Bakış (`/dashboard`) — yeni route
2. Canlı Yayın Planı (`/schedules`) — count badge (örn. 47)
3. Stüdyo Planı (`/studio-plan`) — count badge (örn. 8)
4. Ingest Planlama (`/ingest`) — count badge (örn. 38)
5. MCR (`/mcr`)
6. Monitoring (`/monitoring`) — alert dot + count badge (örn. 2)

**Alt bölüm (4 ek):**
1. Ekip İş Takip (`/bookings`)
2. Haftalık Shift (`/weekly-shift`)
3. Raporlama (`/schedules/reporting`)
4. Audit (`/audit-logs`)

**Eksik olanlar (BCMS'te var ama Shell'de yok):**
- Provys İçerik Kontrol — yetki bazlı; Shell'e eklemek/eklememek karar
- Kanallar — admin-only; Shell'e eklemek/eklememek karar
- Kullanıcılar — SystemEng-only; Shell'e eklemek/eklememek karar
- Ayarlar — SystemEng-only; Shell'e eklemek/eklememek karar
- Dökümanlar — SystemEng-only; Shell'e eklemek/eklememek karar

**Karar (Aşama 1 implementation):** Bu 5 öğeyi de Shell'e ekle (varlığını kaybetmeyelim). Yetki filtreleme `visibleNavItems` computed'unda — RBAC kuralı korunur.

**Sub-section grouping (öneri):**
- Operasyon: Genel Bakış, Canlı Yayın, Stüdyo, Ingest, MCR, Monitoring
- Ekip: Ekip İş Takip, Haftalık Shift
- Yönetim: Kanallar, Kullanıcılar, Ayarlar, Provys, Audit, Raporlama, Dökümanlar

Shell.jsx'te zaten 2 grup var (`nav` + `navMore`); BCMS Shell'inde 3 grup yapacağım — RBAC'taki "Operasyon", "Ekip", "Yönetim" ile uyumlu.

### 3.5 Header (üst toolbar) içeriği

| Element | İşlev |
|---|---|
| Search bar (sol-orta, max 480px) | Cmd+K palette trigger; placeholder "Yayın, kanal, takım, port ara…" |
| Tarih (mono font) | "04 May · Pzt · 19:42 · UTC+3" — canlı saat |
| Alert button | Bildirim simgesi + okunmamış sayısı badge (dış erişim için Prometheus alerts veya BCMS-internal alert sistemi — Aşama 1'de **placeholder**) |
| Reminder button | Hatırlatıcı (placeholder) |
| Primary button | "+ Yeni Yayın Kaydı" — modal trigger |

**⚠️ Placeholder uyarısı:** "Alert" ve "Reminder" sistemleri BCMS'te şu an mevcut değil. Aşama 1'de **boş icon button** olarak konur (functionality yok); Aşama 2/3 sırasında ihtiyaç doğunca implement edilir. Bu **phantom state** üretimi sınırı içinde — sadece UI iskelet, **placeholder data yok**.

### 3.6 Page header pattern

Her sayfa Shell'e şu prop'larla wrap edilir:

```ts
<bp-shell active="schedules"
          eyebrow="04 MAYIS 2026 · PAZARTESİ"
          page="Canlı Yayın Planı"
          [tabs]="[{label:'Bugün'}, {label:'Yarın'}, {label:'Bu hafta'}]"
          activeTab="bugün">
  <!-- sayfa içeriği -->
</bp-shell>
```

`eyebrow` (uppercase + mor accent) + `page` (h1) + opsiyonel sub-tab'lar.

---

## 4. Implementation — File-by-file

### 4.1 Yeni dosyalar

| Dosya | İçerik |
|---|---|
| `apps/web/src/styles/tokens.scss` | beINport tokens.css'ten port (CSS variables) |
| `apps/web/src/app/core/ui/status-tag.component.ts` | StatusTag component (state → renkli badge) |
| `apps/web/src/app/core/ui/sev-tag.component.ts` | SevTag component (severity → badge) |
| `apps/web/src/app/core/ui/card.component.ts` | Card with header (title + count + action) + body |
| `apps/web/src/app/core/ui/kpi.component.ts` | KPI panel (label + value + unit + sub) |
| `apps/web/src/app/core/ui/bar.component.ts` | Progress bar (gradient mor) |
| `apps/web/src/app/core/ui/page-header.component.ts` | Eyebrow + h1 + tabs slot |
| `apps/web/src/app/core/ui/command-palette.dialog.ts` | Cmd+K palette dialog (Material Dialog tabanlı) |
| `apps/web/src/app/core/ui/alert-popover.component.ts` | Header alert badge popover (placeholder veri ile başla) |
| `apps/web/src/app/core/ui/new-broadcast.dialog.ts` | 3-step modal (Maç & Yayın / Teknik / Ekip & Onay) — sadece UI iskelet, save logic Aşama 2'de |

### 4.2 Değişen dosyalar

| Dosya | Değişiklik |
|---|---|
| `apps/web/src/styles.scss` | `tokens.scss` import; status-badge sınıfı kaldırıldı (component'e taşındı); global resets güncel; eski Material 21 dark theme **çıkarıldı** |
| `apps/web/src/app/app.component.ts` | Komple yeniden yaz — Shell.jsx pattern (sidebar + header + page header slot) |
| `apps/web/src/index.html` | Title "beINport — ..."; Inter Tight + Inter + JetBrains Mono CDN; favicon kalır (mevcut beinport-32) |

**Çıkarılacak:**
- Material 21 M3 theme — kullanılmıyor (custom design)
- `mat.all-component-themes` — bazı Material component'ler hâlâ kullanılır (form-field, dialog, menu) ama yeni tasarımla custom override edilir; M3 default tema gereksiz

**Material'ı tamamen mi atıyoruz?** Hayır:
- `MatDialog` — modal'lar için kullanılır (yararlı)
- `MatMenu` — dropdown'lar için (kullanılır)
- `MatFormField` / `MatInput` — opsiyonel, custom tasarımla değiştirilebilir
- `MatTable` — Studio Plan tablosu kullanıyor (KORUMA), dokunulmaz
- `MatIcon` — Material Icons font için kullanılır (icon font'u korunur)

**Yaklaşım:** Material temasını **devre dışı bırak** ama Material **module'ları kullan** (component'ler için). Custom CSS ile override.

### 4.3 Brand asset

Shell.jsx'te brand text-based:
```
[be][IN][port]   <- "be" siyah, "IN" siyah, "port" mor (büyük metin)
[WORKFLOW]       <- subtitle, küçük letter-spacing
```

Mevcut `beinport-logo.svg` görsel — Aşama 1'de **kullanılmıyor**. Onun yerine inline metin (Shell.jsx pattern'ine uygun).

`assets/branding/beinport-logo.svg` repo'da kalır (ileri kullanım için), ama Shell render etmez.

### 4.4 RBAC korunması

Mevcut nav filter logic (`visibleNavItems` computed) **aynen korunur**:
- `groups: []` → tüm authenticated user
- `groups: [GROUP.Admin]` → Admin only
- `groups: [GROUP.Admin, GROUP.MCR]` → Admin veya MCR
- Admin: tüm filter'ları bypass (`isAdminPrincipal` pattern)

Yeni Shell pattern'de bu logic'i `visibleSidebarItems` olarak yeniden adlandırırım, davranış aynı.

---

## 5. Verify Checklist (Aşama 1 sonrası)

```bash
# Type-check
npx tsc --noEmit -p apps/web/tsconfig.json

# Build (lokal, network yok)
npm run build -w apps/web

# Deploy (lokal)
docker exec bcms_web sh -c '... rm + docker cp ...'
docker exec bcms_web nginx -s reload

# HTTPS verify
curl -s --cacert infra/tls/ca/root.crt --resolve beinport:443:127.0.0.1 https://beinport/ | grep -E "<title>"
# Beklenen: "beINport — ..."

# CSS bundle: bp-purple-500 + Inter
curl -s ... /styles-*.css | grep -oE "(--bp-purple-500|Inter Tight|7c3aed)"

# Main bundle: Shell + StatusTag
curl -s ... /main-*.js | grep -oE "(StatusTag|SevTag|brandPort|sidebar)"
```

### Browser test (kullanıcı yapar)

1. Hard reload (Ctrl+Shift+R)
2. `https://beinport/` aç
3. **Görsel beklentiler:**
   - Sol mor gradient sidebar (#4c1d95 → #2e1065)
   - "be IN port" brand + "WORKFLOW" subtitle
   - Üstte search bar (Cmd+K) + tarih + alert/reminder + "+ Yeni Yayın Kaydı"
   - Page header: eyebrow + h1 + (varsa) tabs
   - Mevcut sayfaların **içeriği aynı** (Aşama 1'de sayfaları redesign etmiyoruz — sadece çevreleri yeni tasarım)

**Not:** Aşama 1 sadece Shell ve foundation. Sayfa içerikleri (table, form, dashboard) eski stilde kalır → Aşama 2/3'te o sayfa redesign'ları yapılır.

---

## 6. Implementation Sırası (atomik commit)

```
1. tokens.scss yeni (beINport tokens'tan port)
2. styles.scss güncelle (tokens import + status-badge çıkar)
3. UI component'ler yaz (status-tag, sev-tag, card, kpi, bar, page-header)
4. Cmd+K palette dialog yaz
5. New broadcast modal iskelet (placeholder save)
6. Alert popover iskelet (placeholder data)
7. app.component.ts rewrite (Shell pattern)
8. index.html güncelle (Inter fonts, title)
9. Type-check (tsc)
10. Build (npm run build)
11. Deploy (docker cp + reload)
12. Local verify (curl)
13. Memory note: bcms_tls_internal_ca.md vs bcms_ui_v2_redesign_scope.md cross-ref
14. Single atomic commit
15. Push: kullanıcı onayı bekler
```

---

## 7. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Mevcut sayfa CSS'leri yeni shell ile çakışır (örn. `app-root scale(0.8)`) | styles.scss'ten `app-root` scale kaldır; full viewport kullan |
| Material theme çıkarınca Material Dialog/Menu görsel olarak bozulur | Custom override CSS ile dialog/menu görsel ile uyumlu |
| Inter font yüklenmediğinde fallback Roboto'ya düşer | `font-family: 'Inter', 'Roboto', system-ui, sans-serif` chain |
| RBAC filtering yeni Shell'de bozulur | Mevcut `visibleNavItems` logic'ini birebir taşı |
| Cmd+K palette eski Cmd+K (önceki tema'da yapılmış) ile çakışır | Önceki tema stash'te, conflict yok; yeniden yazıyorum |
| Studio Plan sayfasının kendi SCSS'i (dark theme) yeni tema ile çakışır | Studio Plan **KORUMA** kapsamında — kendi style'ı eski kalır; sadece sayfa shell'i (header) yeni tasarım. Aşama 1'de bu sayfa-bazlı çakışma yok (çünkü Aşama 1 sadece Shell). |
| Yeni Material override'ları eski Schedule List'in dark theme'i ile çakışır | Aynı — sayfa içerikleri eski stil + yeni shell. Aşama 2/3'te sayfa-by-sayfa harmonize edilir. |

---

## 8. Stash durumu

`stash@{0}: deferred-theme-faz1-1.5-2026-05-04` (önceki light + top nav denemesi) — **siliniyor mu?**

Önerim: **siliyorum**. Yön farklı, içeriği yeniden kullanılmıyor. `git stash drop stash@{0}` ile.

İtirazın varsa söyle, saklı tutarım.

---

## 9. Tahmini süre

- Implementation: 4-6 saat solo + AI assist
- Build/deploy/verify: 30 dk
- Toplam Aşama 1: **1 gün**

Aşama 2 (Pilot) ve Aşama 3 (geri kalan sayfalar) ayrı PR'larda.

---

## 10. Onay sorusu

Senden şu netleşmesini bekliyorum:

### Q1: Sub-section grouping
Şu yapı mı:
- **Operasyon:** Genel Bakış, Canlı Yayın, Stüdyo, Ingest, MCR, Monitoring
- **Ekip:** Ekip İş Takip, Haftalık Shift
- **Yönetim:** Kanallar, Kullanıcılar, Ayarlar, Provys, Audit, Raporlama, Dökümanlar

Veya beINport Shell.jsx'teki yapı:
- **Üst (6):** Genel Bakış, Canlı Yayın, Stüdyo, Ingest, MCR, Monitoring
- **Alt (4):** Ekip İş Takip, Haftalık Shift, Raporlama, Audit

(beINport'ta Provys, Kanallar, Kullanıcılar, Ayarlar, Dökümanlar **yok** — bu kararını netleştir: Shell'e ekleyeyim mi yoksa beINport gibi sade tutayım mı?)

### Q2: Material temasını tamamen at mı, hibrit mi?

- **A) At:** Material default theme yok; her component custom CSS ile override.
- **B) Hibrit:** Material kalır (form-field, dialog, menu use), sadece tema renkleri custom.

Önerim: **B (hibrit)** — daha az iş, mevcut Material kullanan kodlar bozulmaz.

### Q3: Stash silme
`stash@{0}` (önceki tema) silinsin mi?

- **A) Sil** (önerim — yön farklı, kullanılmıyor)
- **B) Sakla** (gelecek için referans)

### Q4: Alert/Reminder placeholder
Header'daki alert/reminder iconları **boş button** olarak gelsin mi?

- **A) Evet, placeholder iskelet** (Aşama 2/3'te functionality eklenir)
- **B) Aşama 1'de hiç koyma** (sadece search + new broadcast button)

Önerim: **A** — visual continuity, ileride kolay bağlanır.

---

Cevaplarını al, **"yap"** dedikten sonra implement'e başlıyorum. Tahmini 4-6 saat.
