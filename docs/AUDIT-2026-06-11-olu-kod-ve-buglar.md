# AUDIT — Ölü Kod & Kesin Buglar (2026-06-11)

> **UYGULAMA DURUMU (aynı gün):**
> ✅ **A1** → `168019b` (havuz onClose'a bağlandı) · ✅ **B1** 22 export → `df43d91` ·
> ✅ **B2** 3 bileşen+liveCount → `bd25090` · ✅ **B3** SendToPlayback zinciri → `dafd094` ·
> ✅ **B4** STORAGE_HOST → `f6dd9ac` · ✅ **B5 kararları uygulandı** (aşağıda).
> Doğrulama: typecheck 0 hata · 616/616 unit test · build'ler temiz · api+worker+web healthy.
> **Net ~730 satır silindi. AUDIT KAPANDI — 2026-06-11.**

> Kapsam: tüm kod tabanı — api (194 dosya / 43.813 satır), web (140 / 34.678), shared (18 / 1.726).
> İlke: **yalnız %100 doğrulanmış** bulgular. Her madde repo-geneli (spec + tests/ dahil)
> sıfır-referans taramasıyla tek tek kanıtlandı; şüpheliler (parser sınırı, dinamik erişim,
> imaj-içi env) ELENDİ ve "elenenler" bölümünde gerekçesiyle listelendi.

## Metodoloji
1. `ts-prune` ×3 paket → ham aday listeleri (api 40, shared 136, web 0).
2. Her aday sembol için repo-geneli `\bSymbol\b` taraması (apps/api+web, packages/shared, tests/;
   tanım satırı ve barrel re-export hariç) → **gerçek sıfır-kullanım** filtresi.
3. Endpoint çapraz kontrolü — çift yönlü: 154 backend route ↔ 131 frontend `api.*` çağrısı
   (path normalize: `:param`/`${}` → `*`; çok-satırlı tanımlar literal-grep ile ikinci tur doğrulandı).
4. Prisma 74 model: `prisma.x` + `tx.x` + dinamik delegate (`lookup.registry`) dahil erişim taraması.
5. Env zinciri: compose ↔ `process.env.X` + `env.X` (param stili) + infra script + `opta_smb_watcher.py`.
6. Web bileşenleri: exported class'lara tanım dosyası dışı referans sayımı (+ selector teyidi).

---

## A) Kesin BUGLAR

| # | Bulgu | Kanıt | Şiddet |
|---|---|---|---|
| A1 | **SSDB bağlantı havuzu shutdown'da kapatılmıyor.** `closeSsdbPool` (`apps/api/src/modules/ssdb/ssdb.client.ts:126`) export edilmiş ama **hiçbir `onClose` hook'una bağlanmamış** (repo genelinde 0 çağrı). SIGTERM'de MSSQL havuzu açık kalır → graceful shutdown grace süresini bekletebilir. | `grep -rn closeSsdbPool` → yalnız tanım | Düşük |

**Bug bulunamayan alanlar (negatif sonuçlar — güçlü):**
- Frontend'in çağırıp backend'de **olmayan** endpoint: **0** (26 şüpheli → tamamı parser sınırıydı, literal-grep ile backend'de doğrulandı).
- Erişilmeyen Prisma modeli: **0/74** (lookup'lar `lookup.registry` üzerinden dinamik erişiliyor).
- Kodun okuyup hiçbir yerde set edilmeyen **kritik** env: **0** (18 aday → tümü opsiyonel/dev: `DEV_USER_*` skip-auth, `EGS_*` DB-fallback, `FFMPEG_PATH`, `*_DRY_RUN`, `RABBITMQ_OPTIONAL`, `NOTIFY_SSE_HEARTBEAT_MS`, `NEWS_WIRE_*`).

**Bilinen/bilinçli sınırlar (bug DEĞİL, kayıt için):**
- `ctmsPollTransferStatus` her zaman `done` döner (V1 fire-and-forget; plan: `docs/transfer-durum-takibi-plani-2026-06-09.md`).
- Ingest "Canlı Yayın Planından Ingest Başlat — geçici devre dışı (B5a)" butonu (`ingest-list.component.ts:379`) — bilinçli placeholder.
- Ingest ffmpeg pipeline (worker/watcher/qc) **canlı koddur**; capture planı Faz-4'te kaldırılacak — bugün ölü sayılmaz.

---

## B) Kesin ÖLÜ KOD

### B1. API — sıfır-referanslı 22 export (`apps/api/src/...`)
> Düzeltme (uygulama sırasında): ilk listedeki `news.service.NewsBulletinInclude/NewsStoryInclude`
> aslında `satisfies Prisma.X` satırlarıydı (yerel export değil — ts-prune yanılgısı) → elenenlere taşındı.

**Fonksiyon/sabit (asıl temizlik adayları):**
| Dosya:Satır | Sembol | Not |
|---|---|---|
| `modules/provys/provys.service.ts:395` | `syncProvysFile` | **41 satır** legacy ingest yolu (composed-merge öncesi) |
| `modules/ssdb/ssdb.client.ts:126` | `closeSsdbPool` | bkz. A1 — silme DEĞİL, bağlama önerilir |
| `lib/service-heartbeat.ts:117/50/74` | `isAllAlive`, `ServiceName`, `_resetHeartbeatsForTests` | hiçbir spec dahi kullanmıyor |
| `modules/asrun/asrun.service.ts:26` | `ASRUN_AUDIT_ENTITY` | sabit, 0 kullanım |
| `modules/provys/provys.service.ts:17` | `PROVYS_AUDIT_ENTITY` | sabit, 0 kullanım |
| `modules/opta/opta.parser.ts:836` | `MAX_XML_BYTES` | sabit, 0 kullanım |
| `modules/outbox/outbox.routing.ts:39` | `KNOWN_OUTBOX_EVENT_TYPES` | 0 kullanım |
| `modules/restore/restore.worker.ts:340` | `_resetRestoreWorkerStateForTests` | test-seam, spec'ler kullanmıyor |
| `modules/search/search.worker.ts:235` | `_resetSearchWorkerStateForTests` | test-seam, spec'ler kullanmıyor |
| `modules/transfer/transfer.worker.ts:303` | `_resetTransferWorkerStateForTests` | test-seam, spec'ler kullanmıyor |

**Tip-only exportlar (zararsız ama ölü):** `booking.schema.ListBookingsQuery` ·
`live-plan.schema.{LivePlanStatusValue, CreateFromOptaDto, LivePlanExportRequest}` ·
`lookup.schema.{CreateLookupDto, CreateTechnicalCompanyDto, CreateEquipmentOptionDto, UpdateLookupDto, ListLookupQuery}` ·
`outbox.types.OutboxEventStatus`

### B2. WEB — sıfır-referanslı bileşenler (343 satır silinebilir)
| Dosya | Satır | Kanıt |
|---|---|---|
| `core/ui/bar.component.ts` (`BarComponent`) | 34 | class+selector dış referans 0 |
| `core/ui/status-tag.component.ts` (`StatusTagComponent`) | 68 | class+selector dış referans 0 |
| `features/studio-plan/studio-plan-report.component.ts` (`StudioPlanReportComponent`) | 241 | route/nav/import 0 — içindeki `/studio-plans/reports/usage` çağrısıyla birlikte atıl |
| `features/asrun/asrun-merge.component.ts:149` — `liveCount` member | 1 | computed tanımlı, template/TS hiç okumuyor |

### B3. SendToPlayback kalıntı zinciri (2026-06-09 temizliğinin artığı)
Üretimde tek tüketicisi olmayan (yalnız spec fixture'larında geçen) config zinciri:
- `avid.config.ts` **5 alan + 5 env okuması**: `transferEngine`(`AVID_TRANSFER_ENGINE`),
  `transferEngineFallback`(`AVID_TRANSFER_ENGINE_FALLBACK`), `playbackDevice`(`AVID_PLAYBACK_DEVICE`),
  `playbackDeviceFallback`(`AVID_PLAYBACK_DEVICE_FALLBACK`), `transferPriority`(`AVID_TRANSFER_PRIORITY`)
  — satır 126-131. K3 artık CTMS `submitSTPJob` (device/profile = `AVID_STP_*`).
- `avid.soap.ts:31` — `AVID_NS.transferTypes` (tek referans kendi tanımı).
- Temizlikte 2 spec'in `makeConfig` fixture'ı da güncellenmeli.

### B4. Ölü env değişkeni
- **`STORAGE_HOST`** — compose'da api+worker'a geçiriliyor (satır ~260/404), repo genelinde
  (ts/py/sh) **hiçbir tüketici yok**.

### B5. Çağrısız backend yüzeyleri — **KARARLAR (Osman, 2026-06-11) ve uygulama**
| Yüzey | Karar | Uygulama |
|---|---|---|
| **incidents**: `GET /`, `POST /`, `DELETE /:id`, `PATCH /:id/resolve`, `GET+POST /timeline/:scheduleId` (+`TimelineEvent`) | **KALSIN** | İleride olay-yönetimi UI'ı için backend hazır; web bugün yalnız `POST /incidents/report` kullanıyor. |
| **news MOS admin**: `DELETE/PATCH /mos/devices/:id`, `GET /mos/jobs`, `GET /wires/sources` | **KALSIN** | Haber planındaki `mos-config` UI fazının backend'i (Vizrt/KJ çıkışı hedefte). |
| **opta**: `GET /league-teams`, `POST /cache/clear` | **KALSIN** | Çağrısız ama zararsız; ops/ileri kullanım ihtimaline bırakıldı. |
| **bookings**: `POST /import` | **SİLİNDİ** ✅ | Route + `importFromBuffer` (122 satır) + `ImportResult` + **`lib/excel.ts` (61 satır, tek tüketicisiydi)** + bozuk `booking.import.test.ts`. |
| **ingest**: `POST /callback` (HMAC webhook) | **ERTELENDİ** → Capture **Faz-4** | Dış worker hiç olmadı; dosya-ingest temizliğiyle birlikte kalkacak (bkz. `capture-entegrasyon-plani` §12 Faz-4). |
| **ingest**: `POST /report-issue` | **SİLİNDİ** ✅ | Route + `PERMISSIONS.ingest.reportIssue` (web schedules kendi `/incidents/report`'unu kullanıyor; `incidents.reportIssue` korunur). |

**Bilinçli istisnalar (çağrısız ama ölü DEĞİL):** `POST /asrun/merge/rebuild` (ops/backfill — 2026-06-10'da 277 kez kullanıldı) · `GET /capture/*` (Faz-0, yarınki bağlantı günü) · `/opta/sync` (opta_smb_watcher.py çağırıyor) · `GET /asrun/channels|dates`, `GET /users/groups`, `GET /provys/channels`, `GET /schedules/export` vb. — web'de literal/parametrik kullanım teyitli olanlar bu rapora alınmadı.

---

## C) Elenen şüpheliler (yanlış alarm — neden elendi)
- `lookup.registry.TechnicalCompanyType/EquipmentType` → başka dosyalarda kullanılıyor.
- `formatIstanbulDateTime`, `assertSafeTruncateTarget`, `clearPartitionStatusCache`, `isValidEventId`,
  ssdb `_reset*` → spec'ler kullanıyor (test-seam görevini görüyor).
- Shared 136 aday → tamamı api/web'de kullanımda (paket-içi tarama yanılgısı).
- `BACKUP_*`, `SCHEDULE`, `TZ`, `HEALTHCHECK_PORT` → `postgres-backup-local` imajının KENDİ env'leri.
- `BCMS_API_TOKEN/URL`, `OPTA_POLL_INTERVAL`, `OPTA_SMB_*` → `scripts/opta_smb_watcher.py` okuyor.
- `news.service.NewsBulletinInclude/NewsStoryInclude` → `satisfies Prisma.X` ifadeleri; yerel export bile değil (ts-prune parse yanılgısı).
- `/opta/smb-config` "çakışması" → aynı dosyada GET+POST (farklı metod, sorun yok).
- `PATCH /provys/items/:id/note`, `/users` POST/PUT, tüm `/news/*` → çok-satırlı route tanımı;
  literal-grep ile backend'de DOĞRULANDI.

---

## D) Temizlik sırası — TAMAMLANDI ✅
1. ✅ Sıfır-risk silme: B1+B2+B3+B4 (`df43d91`, `bd25090`, `dafd094`, `f6dd9ac`).
2. ✅ A1 fix: `closeSsdbPool` → `onClose` (`168019b`).
3. ✅ B5 kararları alındı ve uygulandı (yukarıdaki tablo): bookings/import + ingest/report-issue
   silindi; incidents/timeline, MOS admin, opta yüzeyleri bilinçli KALDI; ingest/callback
   Capture Faz-4'e ertelendi.

**Kapanış doğrulaması:** typecheck 0 hata · 616/616 unit test · api+worker+web healthy ·
canlıda regresyon yok. Bu audit kapanmıştır; bir sonraki audit yeni dosya olarak açılır.
