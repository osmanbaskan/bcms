# Haber (NewsWorks / NRCS)

## Özet
**EGS NewsWorks 2000 ("TV200P")** adlı eski Win32 + ActiveX/MOS newsroom yazılımının (Windows
Server 2006 üstünde) **native BCMS karşılığı**. Editörler bülten (rundown) oluşturur, haber
(story) yazar/düzenler, KJ/SPOT (altyazı) hazırlar, prompter'dan okur ve **ajans (AA / ileride
AP)** haberlerini içeri çeker. Backend artık **bizim** (Fastify+Prisma+Postgres); ActiveX/Server
2006 bağımlılığı yok.

## Erişim
- **Nav:** OPERASYON > Haber (ikon `feed`)
- **Route:** `/news` → `NewsShellComponent` (`apps/web/src/app/features/news/`)
- **Yetki:** `Admin, Haber` (route guard + nav). Backend: `PERMISSIONS.news.*` (`packages/shared/src/types/rbac.ts`).
  - **Keycloak:** realm'e **`Haber`** grubu eklenmeli (deploy adımı). `Admin` auto-bypass.

## Ne yapıyor
Üç-pane shell (EGS pencere düzenini taklit eder):
- **Sol:** Bülten listesi (Günlük Yayın Akışları) + **Haber Havuzu** (story pool).
- **Orta:** **Akış** (rundown grid, drag-reorder) veya **Prompter** (büyük punto, koyu zemin).
- **Sağ:** **Ajans** paneli (gelen wire'lar; kategori filtresi + 5'erli/10'arlı sayfalama; "Story'ye Çevir").

EGS sözlüğü `.trk` dosyalarından çıkarıldı; terimler birebir: Bülten, Spiker, Haber Havuzu,
KJ, SPOT, CRAWL, ROLL, Bant Süresi.

## Veri modeli (Prisma — `apps/api/prisma/schema.prisma`)
Migration: `20260605120000_news_module` (additive, mevcut tablolara dokunmaz). Tüm yazımlar
audit extension ile denetlenir; soft-delete servis katmanında (`deletedAt`).

| Tablo | Açıklama | Kilit özellikler |
|------|----------|------------------|
| `news_bulletins` | Bülten / rundown | `bulletinDate @db.Date`, `onAirMinute` (TZ-naive gün-dk), `status`, **`version`** (optimistic-lock), soft-delete |
| `news_stories` | Haber (story) | `bulletinId?` (null=havuz), `orderIndex`, `storyType`, `clipDurationSec`, `prompterText`, `locked/lockedBy` (Koru), **`version`**, soft-delete |
| `news_lower_thirds` | KJ / SPOT | `kind` (KJ\|SPOT), `title/line1/line2`, story'ye cascade |
| `news_wire_items` | Ajans haberi | `source` (AA/APTN/RSS/MANUAL), `externalId`, `category`, `priority` (FLASH\|NORMAL), `headline/body`, `usedStoryId?`; `@@unique([source,externalId])` dedup |
| `news_mos_devices` | MOS/Vizrt çıkış cihazı (admin lookup) | `kind` (MOS_TCP\|VIZRT_REST\|XML_FILE), `host/port`, `templateMap`, `active` |
| `news_mos_jobs` | "Yayına Gönder" işi | `action` (KJ/SPOT/CRAWL/ROLL), `payloadXml`, `status` (PENDING/SENT/FAILED) |

Enumlar: `NewsBulletinStatus`, `NewsStoryType` (PKG/VO/VOSOT/READER/LIVE/PHONE/CRAWL/ROLL),
`NewsLowerThirdKind`, `NewsWirePriority`, `NewsMosDeviceKind`, `NewsMosAction`, `NewsMosJobStatus`.

## Veri kaynağı / API (`/api/v1/news` — `apps/api/src/modules/news/`)
| Aksiyon | Endpoint | Not |
|---------|----------|-----|
| Bültenler (tarih/grup/status) | `GET /bulletins` | storyCount + toplam süre |
| Bülten CRUD / detay | `POST/GET/PATCH/DELETE /bulletins[/:id]` | PATCH **If-Match → 412**; DELETE soft, story'ler havuza döner |
| Akış sırası | `PUT /bulletins/:id/order` | drag-reorder |
| Haber listele | `GET /stories?bulletinId=&pool=&q=&from=&to=` | havuz/bülten/arama |
| Haber CRUD | `POST/GET/PATCH/DELETE /stories[/:id]` | PATCH If-Match + **kilit kontrolü (409)** |
| Koru / Kaldır | `POST /stories/:id/lock \| /unlock` | EGS "Haberi Koru" |
| Bültene taşı / havuza al | `POST /stories/:id/move` | |
| KJ/SPOT toplu | `PUT /stories/:id/lower-thirds` | |
| **Yayına Gönder** | `POST /stories/:id/send` | KJ/SPOT/CRAWL/ROLL → MOS job; `dryRun` ile **XML önizleme** |
| MOS cihaz config (admin) | `GET/POST/PATCH/DELETE /mos/devices` | |
| MOS job durum | `GET /mos/jobs` | |
| Ajans listesi | `GET /wires?source=&priority=&used=` | FLASH önce |
| Manuel ajans | `POST /wires` | |
| **Story'ye Çevir** | `POST /wires/:id/to-story` | wire → havuz haberi |

Konvansiyon: Zod → audit extension → `requireGroup(...PERMISSIONS.news.*)`; hata matrisi
(400/404/409/412); Europe/Istanbul TZ.

## Worker servisleri (yalnız `worker` container — `BCMS_BACKGROUND_SERVICES`)
- **`news-mos-sender`** — PENDING MOS job'larını cihaza gönderir (MOS_TCP socket / VIZRT_REST HTTP /
  XML_FILE dosya); SENT/FAILED, retry. Cihaz yoksa dry-run önizleme route'tan döner.
- **`news-wire-fetcher`** — konfigüre RSS kaynaklarından (`NEWS_WIRE_RSS_URLS`) `NewsWireItem` üretir
  (manuel giriş de mümkün).
- **`news-aa-fetcher`** — **AA (Anadolu Ajansı) Media API doğrudan** (aşağıda).

## AA (Anadolu Ajansı) entegrasyonu
**Doğrudan AA Media API** — yerel IOSTEK NEWS sunucusu (172.28.208.254) **baypas** (ürün lisansı
`INVALID_LICENCE_KEY` ölü; AA kimliği/abonelik sağlam, kanıtlandı). `news-aa-fetcher` worker'ı:
1. `POST https://api.aa.com.tr/abone/search/` (Basic auth, `filter_type=1` metin, `filter_language=1` TR) → id listesi.
2. Her yeni id → `GET /abone/document/{id}/newsml29` → **NewsML-G2 (IPTC 2.9)** içerik.
3. **`newsml-g2.parser.ts`** ile parse (headline / body[nitf] / **kategori** AAcat:* → Spor/Ekonomi/Genel/Bilim,Teknoloji / FLASH / tarih) → `NewsWireItem` (source=`AA`) upsert.
- **Dedup:** `(source, externalId)` unique → cursor gerekmez.
- **Self-heal:** dokümanı o an çekilemeyen item gövdesiz kaydedilir; sonraki poll'de tekrar denenir.
- **Parser AA+AP ortaktır** (AP/APTN de NewsML-G2 — bkz. Bekleyen).
- Tek seferlik backfill: `apps/api/scripts/aa-backfill.ts`.

## Frontend bileşenleri (`apps/web/src/app/features/news/`)
- `news-shell.component` — orchestrator (3-pane, signals, dialog açar, NewsService çağırır).
- `bulletin-list.component` — bülten listesi + inline "Yeni Bülten".
- `rundown.component` — Akış grid (CDK drag-drop, toplam süre, satır aksiyonları).
- `prompter.component` — prompter görünümü (punto/ayna kontrolü).
- `wires.component` — Ajans paneli (**5-çip kategori filtresi**: Tümü/Spor/Ekonomi/Genel/Bilim,Teknoloji; **5'erli sayfalama**; manuel giriş).
- `story-editor-dialog.component` — Haber editörü (**%75 en × %75 boy**; üstte 5 alan yatay; altta Prompter | KJ/SPOT dikey alanlı; Koru/Kilitle; büyük/küçük harf).
- `send-to-air-dialog.component` — KJ/SPOT/CRAWL/ROLL "Yayına Gönder" + dry-run XML önizleme.
- `news.service` — `/api/v1/news` sarmalayıcı (optimistic-lock için patch(version)).

## İş akışı
```
Ajans (AA) → "Story'ye Çevir" → Haber Havuzu
   → (çift tık) düzenle (tür/süre/spiker/prompter/KJ-SPOT)
   → bülten seç → ↓ ile Akış'a ekle
   → Akış'ta sırala → Prompter'da oku → KJ/SPOT'u Yayına Gönder (MOS/Vizrt)
```

## Config (env)
| Değişken | Varsayılan | Açıklama |
|----------|-----------|----------|
| `AA_API_USER` / `AA_API_PASS` | — | AA Media API Basic auth (yoksa `news-aa-fetcher` kapalı). **Sırdır** — go-live öncesi rotate et. |
| `AA_API_BASE` | `https://api.aa.com.tr` | |
| `AA_API_POLL_SECONDS` | `300` | |
| `AA_API_FILTER_TYPE` / `_LANGUAGE` / `_CATEGORY` | `1` / `1` / — | 1=metin, 1=TR |
| `AA_API_SEARCH_LIMIT` / `_DOC_FORMAT` | `30` / `newsml29` | |
| `NEWS_WIRE_RSS_URLS` | — | RSS kaynakları (`Ad=URL`, virgülle) |

## Deploy / çalıştırma
- **Migration:** additive — `prisma migrate deploy` (canlıda **`migrate dev` YASAK**, drift→reset).
- **Worker servisleri:** `docker-compose.yml` → worker `BCMS_BACKGROUND_SERVICES`'e `news-mos-sender,news-wire-fetcher,news-aa-fetcher` ekli.
- Değişiklik sonrası: `docker compose up -d --build api worker web`.
- **Keycloak:** `Haber` grubu (kod-dışı deploy adımı).
- **Go-live temizliği:** `db-temizleme.md` → news tabloları TRUNCATE listesinde (`news_mos_devices` config korunur).

## Test
- **Unit:** `newsml-g2.parser.unit.spec.ts` (parse + FLASH + Türkçe-İ + edge); `npm run test:unit -w apps/api`.
- **E2E (Playwright):** `/news` akışı (bülten→haber→reorder→prompter→KJ gönder→Ajans→Story'ye Çevir), 5-çip filtre + sayfalama, editör %75×%75 boyut, 0 console hatası.
- Not: parser AA `newsml29` gerçek örneğine karşı doğrulandı.

## Bağlantılar (neye bağlı)
- **`@bcms/shared`** — `news.ts` tipleri + `rbac.ts` (`Haber` grubu, `PERMISSIONS.news`).
- **AA Media API** (`api.aa.com.tr/abone`) — abone `3000770`.
- **MOS/Vizrt** — `news_mos_devices` cihaz config'i (Pilot Edge/Media Sequencer hedefi).
- **db-temizleme.md** — go-live veri sıfırlama.

## Bekleyen / sonraki
- **AP / APTN** — BEINAPTN (172.28.208.195) `BS_APTN_XML_INEWS` ajanı NewsML-G2'yi `D:\BS_APTN_XML_INEWS…`'e bırakıyor (Avid iNEWS'e besliyor). **Aynı `newsml-g2.parser` kullanılır.** İki yol: (B) klasör izleyici `news-ap-watcher` (önerilen, AP ajanı çalışıyor) ya da (A) doğrudan AP Media API (`api.ap.org/media/v`, apikey). Video (8080) v1 dışı (yük → ingest/proxy).
- **Eski EGS içerik importer'ı** (`.RDN`/`.egs`/PROMPTER → Postgres) — ayrı iş.
- KJ/SPOT kategorisini çevrilen story'ye grup/etiket taşıma; Ajans'ta "Story'ye Çevir → direkt bültene" opsiyonu.
