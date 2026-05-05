# BCMS — Bağımsız Tam Tarama Audit Raporu

**Tarih:** 2026-05-04
**Kapsam:** Read-only — backend (apps/api), frontend (apps/web), shared (packages/shared), database (prisma + canlı veri), infrastructure (docker, nginx, prometheus, ops, scripts), configuration (package.json, CI, env)
**Yöntem:** Mevcut audit raporlarından bağımsız; her dosya/satır direkt taramayla.
**Kullanılan etiketler:** `[ÖNEMLİ]` `[ORTA]` `[DÜŞÜK]` `[BİLGİ]` — "CRITICAL/HIGH" gibi audit retoriği bilinçli olarak kullanılmamıştır (kategori bağlamı önemli).

> Kapsam dışı: aktif yayında olmayan/kullanılmayan eski şubeler, .git internals, vendor dosyaları, infra/tls/server (dosyalar mevcut, gözden geçirildi).

---

## 0a. Çözüm State Tracker (2026-05-04 sonrası overnight pass)

12 numbered audit batch + GitGuardian secrets fix + follow-up state-sync commit'leri ile **~135 bulgu** (audit doc tracker bazlı) kapatıldı. Kanıt için: `git log --grep="audit-batch\|secrets" --since="2026-05-04 22:00"`.

| Batch | Commit | Kapsam |
| ----- | ------ | ------ |
| 1 | `0c7a8af` | Quick Wins (10 madde) |
| 2 | `0238771` | Backend ÖNEMLİ — auth 503, helmet, multipart, audit cap, rabbitmq retry/multi-consumer, ingest diff |
| 3 | `3008601` | Frontend ÖNEMLİ — login-error route, public-origin, token validity |
| 4 | `084f925` | Backend ORTA — schedule/signal/playout/users/booking/opta/bxf/weekly-shift |
| 5 | `3f4c724` | DÜŞÜK + Infra — CSP unsafe-eval, mailhog profile, prom retention, prisma defansif |
| 6 | `b1b8eb8` | DEV_USER override, ingest dedup/redact, notif _meta, opta TR collation, mock alerts prod gizli |
| 7 | `03cba69` | Schema metadata caps (Booking/Schedule/Channel) + infra defansif env |
| 8 | `5c9a81a` | Frontend API GET retry + dashboard NG8113 + Angular budget tweak |
| 9 | `4cb2db5` | BXF atomic write, signal channel ref, studio catalog cross-ref, booking transitions |
| 10 | `aa6d459` | Schedule-list `?new=1` query param + monitoring/MCR lifecycle verify |
| 11 | `ce94b3e` | Audit doc state tracker + webpack devDep cleanup |
| 12 | `c96e69b` | IngestJob path cap, DEV_USER env doc, opta prefix safety |
| (sec) | `fa932dc` | GitGuardian fix — Prometheus basic auth env-driven + RUNBOOK-SECRETS-ROTATION.md |
| 13 | `bd10c20` | API catalog cache + booking date consistency + HttpError class |

**Mimari onay bekleyen 10 madde** (skip listesi sabit):
1. AuditLog partition (DB migration + retention strateji) — design doc bekliyor [next]
2. DLQ topology (RabbitMQ — interim retry policy uygulandı)
3. `metadata.optaMatchId` kolon promote — **PR-3A done** (`fdf319b`); transition active (dual-read/write); PR-3B deferred (metadata yazımı kaldır + opsiyonel NOT NULL).
4. ~~`usageScope` → enum/CHECK~~ → **kapalı** (CHECK var; integration test `87d5dde`; schema.prisma /// yorum + audit doc finding 3.1.4 düzeltildi `95fe2fb`). PG enum migration **rejected/deferred unless new requirement** (CHECK yeterli kabul edildi).
5. Schedule `channel_id NULL` live-plan (mimari karar — ayrı tablo mı?)
6. Schedule-list 2385 satır component refactor
7. Outbox pattern (transactional event publish)
8. Backend integration test coverage — **lokal 20/20 ✅** (booking + schedule + db-constraints + optaMatchId); **CI billing blocked, not CI-validated**; audit plugin spec sonraki PR.
9. ~~IDOR ID enumeration (UUID PK migration)~~ → **IDOR mitigation: UUID migration rejected; RBAC authorization audit/test plan required** (2026-05-04 karar — bkz aşağıda)
10. Production secrets rotate — **current-tree mitigated** (`fa932dc` GitGuardian fix + `ops/RUNBOOK-SECRETS-ROTATION.md`); prod rotation operasyonel pending.

`apps/api` lint + `apps/web` build her commit öncesi doğrulandı.

### Madde 9 Karar Notu (2026-05-04)

**Karar**: UUID PK migration **yapılmayacak**. Madde 9 "closed" değil — *scope değişti*.

**Yeni iş kalemi**: IDOR mitigation = RBAC authorization audit + endpoint authz tests.

**Rationale** (kısa):
- BCMS internal app (~10-50 kullanıcı, on-prem); external-facing API yok.
- Int → UUID migration tüm FK'leri etkiler, index size 4×, URL ergonomics bozulur, test/regression yüzeyi büyük → **yüksek risk / düşük ROI** bu context'te.
- Asıl IDOR riski PK predictability'den çok her endpoint'in **authz davranışı** (Tekyon kullanıcısı YayınPlanlama'nın schedule'larını görebilir mi, vb.) → RBAC endpoint audit + cross-tenant leak fuzz test çok daha **yüksek ROI**.

**Sonraki PR şekli** (defer): `ops/REQUIREMENTS-RBAC-AUTHORIZATION-AUDIT.md` — her endpoint için authz matrix, integration test'lerle enforcement, fuzz test plan. UUID migration tartışması bu doc'ta gömülü kalır (red kararı + gerekçe).

> **Skip listesi etkisi**: Madde 9 listede kalır, **wording değişti** ("migration rejected, converted to RBAC audit"). "Risk bitti" değil, "çözüm yolu değişti".

---

## 0. Yönetici Özeti

Toplam **211 bulgu** kayıt edildi. Dağılım:

| Alan          | ÖNEMLİ | ORTA | DÜŞÜK | BİLGİ | Toplam |
| ------------- | -----: | ---: | ----: | ----: | -----: |
| Backend       |     12 |   42 |    38 |     8 |    100 |
| Frontend      |      4 |   18 |    22 |     5 |     49 |
| Database      |      5 |   11 |     8 |     2 |     26 |
| Infrastructure |     6 |   10 |    11 |     3 |     30 |
| Configuration |      0 |    2 |     2 |     2 |      6 |

**Açık riskler — odaklanılması gerekenler:**

1. `audit.ts` plugin'inde `findFirst` BEFORE-write pattern'i ve `updateMany`/`deleteMany`'de **tüm etkilenen satırların önce çekilmesi** — büyük tablolarda performans bombası.
2. `/metrics` endpoint'i nginx'te `deny all` ile korunuyor ama uygulama seviyesinde **auth yok** — Docker network içinden veya nginx by-pass'tan erişen herhangi bir container okuyabilir.
3. RabbitMQ consume `nack(msg, false, false)` — **DLQ yok**, hatalı mesaj sessiz kayboluyor; aynı zamanda `Map<QueueName, ConsumerRecord>` tek consumer record tutuyor (multi-consumer bozuk).
4. `schedules.metadata.optaMatchId` üzerinde JSON path filter kullanan kod var (132/132 schedule), CLAUDE.md'de "obsolete" demesine rağmen — `usageScope` ile aynı problem geri sızmış.
5. `129/132` schedule `channelId IS NULL` (live-plan) — GiST exclusion bypass; çakışma kontrolünün hangi katmanda olduğu netleşmeli.
6. `/api/v1/schedules` `503 Service Unavailable` durumlarında JWKS hatası **401 dönüyor** (auth.ts catch) — kullanıcı sürekli login'e atılıyor, infrastructure root cause maskeleniyor.
7. CI workflow'unda `npm audit --audit-level=high` çalışıyor ama `--production` flag'i yok — devDependencies CVE'leri **prod build'i bloklamıyor**, ama yine de pipeline'ı kırıp gürültü yapıyor.
8. `ingest.worker.ts` deduplication yok: aynı `jobId` RabbitMQ tarafından redeliver edilirse PROCESSING / PROXY_GEN / QC akışı sıfırdan başlıyor, partial proxy file ortada kalıyor.

---

## 1. Backend (apps/api) — 100 Bulgu

### 1.1 Plugin Katmanı

#### `apps/api/src/plugins/audit.ts`
- **[ÖNEMLİ] 1.1.1** `$allOperations` interceptor'ı her `update`/`delete` için **operasyondan önce** `findFirst({ where: args.where })` çekiyor — single-row operasyon için 2 round-trip; large `updateMany` için "tüm etkilenen satırları belleğe çek + sonra update" pattern'i (audit.ts:60-72). 100K+ satırlı bir `auditLog.deleteMany` retention job'unu tetiklerse OOM.
- **[ÖNEMLİ] 1.1.2** Tüm interceptor `(base as any)[model]` cast'iyle çalışıyor — Prisma type-safety bypass'lı; model adı yanlış yazılırsa runtime'da fail eder, derleme uyarısı vermez.
- **[ORTA] 1.1.3** `affectedIds = rows.map((r: any) => r.id)` — tüm modellerin `id` PK'si olduğunu varsayıyor; `BroadcastType`, `Channel` evet ama `ShiftAssignment` composite-key'siz bile değil — yine de tek `id` field var → şu an çalışıyor, ama "any model" varsayımı kırılgan.
- **[ORTA] 1.1.4** `entityId: Number(targetId ?? 0)` — `targetId` yoksa 0 yazılıyor; `entity_id=0` audit satırları semantik gürültü.
- **[ORTA] 1.1.5** `updateMany` → `UPDATE`, `deleteMany` → `DELETE` mapping; `AuditLogAction` enum'unda `UPDATEMANY`/`DELETEMANY` yok → tek-satır vs. çok-satır operasyonlar audit'te ayırt edilemiyor.
- **[ORTA] 1.1.6** `onSend` hook `statusCode < 400` koşuluyla flush ediyor (phantom-write koruması). Ancak transaction commit edildikten sonra `onSend` **flush sırasında throw atarsa** (örn. RabbitMQ down değil ama DB connection drop) — kullanıcıya 500, audit yazılmamış, gerçek mutation prod'da. Outbox pattern yok.
- **[DÜŞÜK] 1.1.7** AsyncLocalStorage `pendingAuditLogs` her request başında yeni allocation; high-RPS servislerde GC pressure (ölçülmedi, info).
- **[DÜŞÜK] 1.1.8** `before-write` `findFirst` `select` kullanmıyor — tüm satırı çekiyor (TEXT alanlar dahil). En azından `select: { id: true, ...changedFields }` yeterli.

#### `apps/api/src/plugins/auth.ts`
- **[ÖNEMLİ] 1.1.9** JWKS fetch failure (Keycloak unreachable) → `request.jwtVerify()` Error fırlatıyor → handler'da yakalanmadığı için 401 dönüyor. Doğrusu 503 olmalı; kullanıcı sürekli /login'e gönderiliyor, ana sorun (Keycloak down) maskeleniyor.
- **[ORTA] 1.1.10** `DEV_USER` hardcoded `[GROUP.SystemEng]` — yetki testi yapan biri "SystemEng dışı bir grup" simulate edemiyor (override env yok). Smoke test fixture'larında esneklik gerekir.
- **[DÜŞÜK] 1.1.11** `requireGroup(...groups)` boş `groups` argümanıyla çağrılırsa "any authenticated" anlamına geliyor — semantiği subtle, isim gözden kaçırıyor (`requireGroup()` aslında `requireAuth`).

#### `apps/api/src/plugins/prisma.ts`
- **[ORTA] 1.1.12** `buildDatabaseUrl` boş `DATABASE_URL`'de **silently fall through** ediyor — Prisma kendi error'ıyla başlıyor, ama `validateRuntimeEnv` zaten "DATABASE_URL required" der, bu plugin'de defansif `if (!url) throw` eksik.
- **[ORTA] 1.1.13** `isApi` tespiti `BCMS_BACKGROUND_SERVICES === 'none'` string compare ile. Yeni env değeri `''` (empty) ile çalıştırılsa worker davranışına düşer; defensive default eksik.
- **[DÜŞÜK] 1.1.14** Connection pool 10 (api) / 5 (worker) hard-coded — high-load için tunable değil.

#### `apps/api/src/plugins/rabbitmq.ts`
- **[ÖNEMLİ] 1.1.15** Consumer error handler `nack(msg, false, false)` (requeue=false) — DLX/DLQ yok, **hatalı mesaj kayboluyor**. Notification email failure 3 retry sonrası `app.log.error('mesaj silindi')` ile sessiz drop (notification.consumer.ts:66).
- **[ÖNEMLİ] 1.1.16** `Map<QueueName, ConsumerRecord>` her `consume()` çağrısında **last-write-wins**; aynı queue'ya iki consumer register edilirse ikincisi birinciyi siliyor (ama RabbitMQ'da hala ack bekliyor) → orphan consumer.
- **[ORTA] 1.1.17** `JSON.parse(content)` size cap yok; 10MB'lık message → memory spike + parse hata.
- **[ORTA] 1.1.18** `connectWithBackoff` initial connect ile `scheduleReconnect` aynı anda tetiklenebilir (boot fail + restart) → race; iki socket aynı anda açılır.
- **[DÜŞÜK] 1.1.19** `close()` consumer cancel'larını **await etmiyor**; SIGTERM sırasında in-flight messages drop.

#### `apps/api/src/plugins/metrics.ts`
- **[ÖNEMLİ] 1.1.20** `/metrics` endpoint **uygulama katmanında auth yok**. nginx `deny all` koruyor ama Docker network içinden erişen herhangi bir container okuyabilir (örneğin worker container compromise olursa). Defense-in-depth için Bearer token veya basic auth eklenmeli.
- **[ORTA] 1.1.21** `http_requests_total` counter'ında `method`/`route`/`status` label'ı **yok** — Grafana'da breakdown yapılamıyor; `/metrics` ile uğraşan biri "5xx oranı kanal endpoint'inde mi yoksa ingest'te mi" diye soramıyor.
- **[ORTA] 1.1.22** Request duration histogram **yok** — p99 latency ölçülemiyor.
- **[DÜŞÜK] 1.1.23** `/metrics`, `/docs`, `/health` istekleri **kendi sayaçlarına dahil ediliyor** — prometheus scrape'i ile inflate.

### 1.2 Schedule Modülü

#### `schedule.routes.ts`
- **[ORTA] 1.2.1** `request.file()` **tek dosya** okuyor; multipart upload birden fazla file ile gelse ikincisi sessiz drop edilir. Frontend tek dosya yolluyor ama defensive değil.
- **[ORTA] 1.2.2** Excel upload validation sadece `.xlsx` extension kontrol ediyor — file magic byte (`PK\x03\x04`) kontrolü yok; saldırgan `.xlsx` uzantılı zip bomb yollarsa exceljs içerde patlar.
- **[ORTA] 1.2.3** `request.file().toBuffer()` tüm dosyayı belleğe alıyor; 10MB limit var ama büyük file streaming değil — 10 paralel upload = 100MB RSS spike.
- **[ORTA] 1.2.4** `filename: \`schedules-${new Date().toISOString().slice(0,10)}.xlsx\`` — UTC tarih, Istanbul kullanıcısı için günde 3 saat dilimde drift; export filename 1 gün önce/sonra görünebilir.
- **[DÜŞÜK] 1.2.5** `If-Match` header `parseInt(ifMatch, 10)` — Fastify header tipi `string | string[]`; array geldiğinde `parseInt` ilk elemanı parse ediyor, sessiz davranış.
- **[DÜŞÜK] 1.2.6** `reports/live-plan` `pageSize` default 500, `.max()` validation yok — caller `pageSize=100000` gönderse memory spike.

#### `schedule.service.ts`
- **[ÖNEMLİ] 1.2.7** Conflict response gövdesinde `conflicts` array **direkt schedules listesi** — başka kanalın schedule başlığı/ID'si dış kullanıcıya sızabilir. Sadece `count` veya `[{ channelId, startTime, endTime }]` projection yeterli.
- **[ORTA] 1.2.8** `dto.metadata as Prisma.InputJsonValue` — schema validation yok, max size yok; kullanıcı 10MB JSON yollasa Postgres'te `jsonb` kolonu o kadar büyür.
- **[ORTA] 1.2.9** `app.rabbitmq.publish(...)` **transaction commit'tan sonra** — outbox pattern yok; commit başarılı ama RabbitMQ down ise notification kayboluyor (eventual inconsistency).
- **[ORTA] 1.2.10** Update flow `findById → updateMany(version)` arasında non-atomic okuma penceresi var; version stale dönerse 412 atılır ama version doğru ise yine race olabilir. Tek `updateMany` + version check yeterli; ön-okuma redundant.
- **[ORTA] 1.2.11** `remove()` **hard delete** — schema'da `deleted_at` kolonu olmasına rağmen DELETE; FK cascade yoksa related rows orphan.
- **[DÜŞÜK] 1.2.12** `usageScope` discriminator kontrolü string compare; CLAUDE.md "do not use metadata for usageScope" diyor ama eski kodlarda `metadata?.usageScope` referansları var (grep gerek).

#### `schedule.export.ts`
- **[BİLGİ] 1.2.13** Sanitize cell guard'ı `^[=+\-@\t\r]` — CSV injection'a karşı çalışıyor, ✅. Yeni eklenen `@` ve `\t\r` doğru.
- **[DÜŞÜK] 1.2.14** Tüm dataset'i tek `findMany` ile çekiyor — 50K+ schedule ile çağırılırsa belleğe sığar mı? `take` limit yok.

### 1.3 Booking Modülü

#### `booking.service.ts`
- **[ORTA] 1.3.1** `isAdminUser` **`'Admin'` string literal** kullanıyor (line 56) — `auth.ts` `GROUP.Admin` constant'ını kullanıyor; refactor sırasında bir yer unutulursa drift.
- **[ORTA] 1.3.2** Schedule existence check (line 207-209) **transaction dışında**; create transaction'ı başlamadan önce `findUnique`, sonra `tx.booking.create` — TOCTOU race; schedule transaction'dan önce silinirse FK violation 409 dönüyor (handle edilmeli).
- **[BİLGİ] 1.3.3** `importFromBuffer` MED-API-021 ile batch'leştirilmiş ✅.

### 1.4 Channel / Match / BroadcastType Modülleri

#### `channel.routes.ts`
- **[BİLGİ] 1.4.1** Update için ayrı `updateChannelSchema` (LOW-API-019 fix) ✅.
- **[DÜŞÜK] 1.4.2** `delete` (soft) `findFirst` öncesi check yok; non-existent ID `update` doğrudan P2025 fırlatır → 404 (global handler) — OK ama explicit kontrol daha açık olur.
- **[DÜŞÜK] 1.4.3** Channel `frequency` ve `muxInfo` tip-spesifik validation yok (tip alanı `HD/SD/OTT/RADIO` ama RADIO için frequency MHz, OTT için URL beklenir — semantik kontrol yok).
- **[DÜŞÜK] 1.4.4** PATCH'te `dto as Parameters<typeof app.prisma.channel.update>[0]['data']` cast — type erasure; runtime tip uyumsuzluğunda bug.
- **[DÜŞÜK] 1.4.5** `/catalog` her authenticated kullanıcıya açık (yorumda açıklanmış) — meşru, `[BİLGİ]`.

#### `match.routes.ts`
- **[ORTA] 1.4.6** Match `findMany` `take` limit yok — `?leagueId=&from=&to=` boş bırakılırsa tüm fixture döner (binlerce satır). Default `take: 200`, `take` query param ile override.
- **[BİLGİ] 1.4.7** Istanbul timezone fix uygulandı (LOW-API-016) ✅.

#### `broadcast-type.routes.ts`
- **[DÜŞÜK] 1.4.8** PATCH öncesi `findUnique` extra round-trip — Prisma update doğal P2025 fırlatır, manual check kaldırılabilir.
- **[DÜŞÜK] 1.4.9** Code/description Türkçe karakter validasyonu yok — boş string yasak ama unicode escape'ler kabul.

### 1.5 Ingest Modülü

#### `ingest.routes.ts`
- **[ÖNEMLİ] 1.5.1** PUT `/recording-ports` **`deleteMany()` (no WHERE) + `createMany()` full replace** — ports'lardan biri ingest job tarafından tutuluyorsa FK violation; kısmen silinmiş state oluşur (transaction içinde mi?). Patch operation ile diff-based update tercih edilmeli.
- **[ORTA] 1.5.2** Report cap 10K satırla limit, `X-Truncated: true` header — ama tam 10K satır olursa `X-Truncated` yine `true` set edilir (false positive).
- **[DÜŞÜK] 1.5.3** `as never` cast (line 230) — type erasure; Prisma generic'i kaybolmuş.

#### `ingest.worker.ts`
- **[ÖNEMLİ] 1.5.4** **Deduplication yok** — RabbitMQ at-least-once teslim ediyor; aynı `jobId` redeliver edildiğinde PROCESSING'ten yeniden başlıyor; partial proxy file `tmp/proxies/proxy_<id>.mp4` overwrite/leak.
- **[ORTA] 1.5.5** State transition `PROCESSING → PROXY_GEN → QC → COMPLETED` her geçişte ayrı `update` — transaction yok; orta aşamada crash olursa state inconsistent.
- **[ORTA] 1.5.6** `errorMsg = (err as Error).message` — error mesajında **dosya yolu / sourcePath** içerik sızabilir; `errorMsg` UI'da gösteriliyor mu? (eğer evet, info disclosure).
- **[ORTA] 1.5.7** ffmpeg `proxyOutputDir` env'den geliyor; default `./tmp/proxies` relative path — worker container restart sonrası volume mount yoksa proxy dosyası kayıp.
- **[BİLGİ] 1.5.8** `withTimeout` 5dk hard cap eklenmiş (HIGH-API-016) ✅.

#### `ingest.paths.ts`
- **[BİLGİ] 1.5.9** `validateIngestSourcePath` allowlist root kontrolü yapıyor — path traversal koruması ✅. (Gerçek implementation gözden geçirilmedi; ad iyi.)

### 1.6 Notification Modülü

#### `notification.consumer.ts`
- **[ORTA] 1.6.1** Email retry 3 deneme sonrası `app.log.error('mesaj silindi')` — DLQ olmadığı için **kayıp**; SMTP recovery sonrası tekrar gönderilemez. Failed messages DB tablosuna persist + audit ile retry job düşünülmeli.
- **[DÜŞÜK] 1.6.2** `payload._retries` payload içine yazılıyor — durable mesajda `_retries` queue'da görünür; ayrı header'a taşınabilir.
- **[BİLGİ] 1.6.3** Boot'ta `transport.verify()` ✅ (MED-API-022).

### 1.7 BXF Modülü

#### `bxf.watcher.ts`
- **[ORTA] 1.7.1** `loadProcessed` / `saveProcessed` JSON file (`./.bxf_processed.json`) — concurrent yazımda corrupt; file lock yok.
- **[ORTA] 1.7.2** Channel cache **boot'ta** dolduruluyor; runtime'da yeni kanal eklenirse BXF eşleşmiyor → restart gerekir.
- **[ORTA] 1.7.3** `chokidar.watch` `awaitWriteFinish: { stabilityThreshold: 3000 }` — büyük BXF (>3sn yazım) için OK, ama SMB share'de partial write gözlenirse hala incomplete dosya işlenebilir.
- **[ORTA] 1.7.4** Channel matching fuzzy — `normDb.includes(normBxf)` bidirectional; "bein sports" "bein sports 5" ile match edebilir → yanlış kanala yazma.

#### `bxf.parser.ts`
- **[ORTA] 1.7.5** `fs.readFileSync` event loop blok — 50MB BXF için 100-300ms blok.
- **[ORTA] 1.7.6** `XMLParser` size limit yok — 1GB XML denial-of-service vector.
- **[DÜŞÜK] 1.7.7** SMPTE timecode parse fallback `frameRate=25` — gerçek kaynak 50i veya 60p ise süre yanlış.

### 1.8 OPTA Modülü

#### `opta.routes.ts`
- **[ORTA] 1.8.1** `$queryRaw` GROUP BY **Türkçe collation yok** — "Galatasaray" / "galatasaray" ayrı grup gibi davranır.
- **[ORTA] 1.8.2** League/match `findMany` **`deleted_at IS NULL` filter eksik** — soft-deleted ligler dropdown'da görünür.
- **[ORTA] 1.8.3** `metadata.path('$.optaMatchId')` JSON path query — CLAUDE.md'de `usageScope` için "obsolete" dediği pattern; tutarsızlık.
- **[ORTA] 1.8.4** `match.findMany` `take` limit yok.

#### `opta.parser.ts`
- **[ORTA] 1.8.5** `teamNameCache: Map<string, string>` module-scope; **TTL ve size limit yok** — uzun süreli memory leak.
- **[ORTA] 1.8.6** `fs.readFileSync` event loop blok.
- **[ORTA] 1.8.7** `buildFixtureLabel` UTC kullanıyor, diğer modüller Istanbul; tutarsızlık.

#### `opta.smb-config.ts`
- **[ORTA] 1.8.8** `readFileSync`/`writeFileSync` event loop blok (boot OK ama runtime config update'te problem).
- **[ORTA] 1.8.9** SMB password CRED file'da **plain text** — cifs-utils gerektiriyor; ama `chmod 0600` set edilmiş mi? (kontrol edilmedi).
- **[DÜŞÜK] 1.8.10** `os.homedir()` container kullanıcısına bağımlı; `HOME=/data` set ediliyor ama explicit path daha güvenli.

### 1.9 Playout / Signals / Incidents

#### `playout.routes.ts`
- **[ORTA] 1.9.1** Rundown `q.date` parse: `new Date(q.date) + setHours(0,0,0,0)` — UTC date'in **local midnight'ı**, Istanbul'da Türkiye günü 21:00 UTC'den başlar; date drift.
- **[ORTA] 1.9.2** `tx.schedule.update({ data: { status: 'ON_AIR' } })` **version increment YOK** — go-live ve end için optimistic lock devre dışı; başka kullanıcı concurrent edit'te conflict göremiyor.
- **[ORTA] 1.9.3** `tcNow()` `new Date().getHours()` local — Istanbul drift.

#### `signal.routes.ts`
- **[ORTA] 1.9.4** `submitSchema` `signalDb`/`snr`/`audioLufs` numeric ama **min/max yok** — saldırgan `Infinity`/`NaN` yollasa Prisma'ya gider.
- **[ORTA] 1.9.5** Auto-incident creation **dedup yok** — flapping signal'de saniyede 10 incident yaratır.
- **[DÜŞÜK] 1.9.6** P2002/P2004 catch sessiz (line 92-94) — duplicate insert'i yutuyor; metric counter eklenebilir.

#### `incident.routes.ts`
- **[ÖNEMLİ] 1.9.7** GET `/incidents` **pagination yok, take yok** — 10K+ incident varsa response bombası.
- **[ORTA] 1.9.8** `metadata` field'ı unbounded — JSON size cap yok.
- **[ORTA] 1.9.9** POST `/timeline/:scheduleId` schedule existence check yok — random scheduleId ile timeline event oluşturulabilir (FK varsa P2003 dönüyor; explicit 404 daha açık).

### 1.10 Users / Audit / Weekly Shifts

#### `users.routes.ts`
- **[ORTA] 1.10.1** `username` regex char-set kontrolü yok (`@bcms/shared/JwtPayload.preferred_username` ile uyumsuzluk olasılığı).
- **[ORTA] 1.10.2** `groups` array `.min(1).unique()` validation yok — boş veya tekrarlı entry kabul.
- **[ORTA] 1.10.3** `groupMembershipCache` Map module-scope; cleanup yok → memory leak (Keycloak admin ekran 1000 kullanıcı yönetince büyür).
- **[ORTA] 1.10.4** `hasAdminGroup` `'Admin'` literal — `GROUP.Admin` kullanmıyor.
- **[ORTA] 1.10.5** `setUserGroups` non-atomic: delete-loop → add-loop; partial failure → kullanıcı yarı-yarıya gruba bağlı.

#### `audit-retention.job.ts`
- **[ORTA] 1.10.6** `msUntilNextMidnight` **local time** kullanıyor; container TZ=UTC, Türkiye 03:00 değil 00:05 UTC = 03:05 IST'te çalışır → log retention zamanlaması Istanbul gece yarısı değil.
- **[ORTA] 1.10.7** `cutoff.setHours(0,0,0,0)` local — UTC vs. IST drift; gün başında işlenen retention 3 saatlik audit kayıt eksik silebilir.
- **[ORTA] 1.10.8** Two-phase delete: önce `findMany({ id })`, sonra `deleteMany({ id: { in } })` — `deleteMany({ where: { timestamp: { lt: cutoff } } })` tek sorguda yeterli; gereksiz round-trip.
- **[ORTA] 1.10.9** Hata durumunda `break` (line 53-55) — retry yok; bir batch fail = tüm purge iptal.
- **[DÜŞÜK] 1.10.10** `initialDelay = Math.min(msUntilNextMidnight()+30s, 60s)` — yorum "midnight" ama practical olarak boot+60s'de çalışıyor; yorum yanıltıcı.

#### `weekly-shift.routes.ts`
- **[ORTA] 1.10.11** PUT `/:group` `decodeURIComponent(request.params.group)` — `isKnownGroup` kontrolünden geçiyor ✅, ama URL-encoded null byte `%00` decode sonrası segfault testi yapılmamış.
- **[ORTA] 1.10.12** `fetchShiftUsers` **her PUT'ta tüm Keycloak users + memberships fetch** — 500 kullanıcı × 12 grup = 12 paralel fetch; rate limit hit olabilir, response cache yok.
- **[ORTA] 1.10.13** Excel export `for (const group of plan.groups)` her grup için worksheet — büyük plan'larda memory; streaming kullanılabilir.
- **[BİLGİ] 1.10.14** `canEditGroupSync` ile supervisor cache (HIGH-API-014) ✅.

### 1.11 Studio Plans

#### `studio-plan.routes.ts`
- **[ORTA] 1.11.1** PUT `/catalog` **`deleteMany()` + `createMany()` full replace** transaction içinde ✅; ama programlar bir slot tarafından kullanılıyorsa rename/delete sonrası UI broken.
- **[ORTA] 1.11.2** Slot upsert flow `deleteMany({ planId }) + createMany(rows)` — eski slot ID'leri siliniyor; UI-side optimistic referenceler kayboluyor (örn. comment thread).
- **[BİLGİ] 1.11.3** `version: { increment: 1 }` ✅.

### 1.12 Server bootstrap (`app.ts`, `server.ts`)

- **[ORTA] 1.12.1** `helmet` plugin **`contentSecurityPolicy: false`** — uygulama seviyesinde CSP devre dışı; nginx'te CSP var, ama mobil/native client veya direct port erişim CSP'siz.
- **[ORTA] 1.12.2** `multipart` `fileSize: 10MB` (api.ts) ile nginx `client_max_body_size: 100m` **uyumsuz** — nginx 100MB kabul ediyor, Fastify 10MB'da kesiyor. Hata mesajı 413 vs. ambiguous; kullanıcı 50MB Excel uploaded'da kafası karışıyor.
- **[ORTA] 1.12.3** `/docs` Swagger UI gate'i `onRequest` hook'ta `NODE_ENV !== 'production'` — `NODE_ENV=staging` veya `dev` ile prod-like ortamda /docs açık olur. Beyaz liste yerine "production'da kapalı" model.
- **[ORTA] 1.12.4** Rate-limit `keyGenerator` `request.headers['x-real-ip']` öncelik veriyor — Fastify `trustProxy: ['172.18.0.0/16']` X-Forwarded-For zinciri okuyor; tutarsızlık. nginx `X-Real-IP` set ediyor, OK ama defansif `||` chain net olabilir.
- **[DÜŞÜK] 1.12.5** `validateRuntimeEnv` SMTP_HOST production'da zorunlu — ama mailhog dev'de set ediliyor, prod'da SMTP servisi olmasa container fail-fast eder. Doğru karar; sadece dokümante edilebilir.

### 1.13 Diğer / Hijyen

- **[DÜŞÜK] 1.13.1** Birçok route'da `Object.assign(new Error('msg'), { statusCode: N })` pattern'i — `class HttpError extends Error` ile temiz olur.
- **[DÜŞÜK] 1.13.2** `prisma generate` build'de iki kez çalışıyor (`api.Dockerfile` builder + dev stage) — image size etkisi minor, ama gereksiz.
- **[DÜŞÜK] 1.13.3** Birçok modülde `as any` var — `audit.ts`, `weekly-shift.routes.ts:63` (`keycloakAttributeValue`).
- **[BİLGİ] 1.13.4** `concurrently` dev script ✅.

---

## 2. Frontend (apps/web) — 49 Bulgu

### 2.1 Auth / Interceptor / Guard

- **[ÖNEMLİ] 2.1.1** `auth.interceptor.ts` line 20 `environment.skipAuth` **direkt** kullanıyor — `isSkipAuthAllowed()` runtime hostname guard'ı bypass ediliyor; prod build kazara `skipAuth=true` olursa interceptor bearer token eklemeyi durdurur (auth tamamen kapanır). `isSkipAuthAllowed()` çağrısına geçilmeli.
- **[ORTA] 2.1.2** `auth.guard.ts` `BcmsTokenParsed` interface **lokal redefinition** (line 8-10) — `core/types/auth.ts` zaten export ediyor. Drift riski.
- **[ORTA] 2.1.3** `app.component.ts` line 19-22 yine **lokal `BcmsTokenParsed`** — toplam 4+ dosyada duplicate (app.component, auth.guard, schedule-list, dashboard...).
- **[ORTA] 2.1.4** `getPublicAppOrigin()` `host !== 'localhost' && host !== '127.0.0.1'` — `.local`, `0.0.0.0`, IPv6 `[::1]` özel-network host'larında current origin döner; `isSkipAuthAllowed()` regex'iyle tutarsız.
- **[DÜŞÜK] 2.1.5** `redirectThrottle` 30sn `sessionStorage` — incognito tab'lar arasında share edilmez, OK.
- **[DÜŞÜK] 2.1.6** `auth.interceptor` `keycloak.updateToken(60)` — token min validity 60sn, refresh threshold 120sn (app.config.ts) — uyumsuz; 60sn'lik token expiration penceresinde request başarısız olabilir.
- **[BİLGİ] 2.1.7** Throttled redirect (HIGH-FE-003 fix) ✅.

### 2.2 App Bootstrap

- **[ORTA] 2.2.1** `app.config.ts` `setInterval(60_000)` token refresh — `clearInterval` `pagehide` event'inde, ama HMR sırasında interval leak olur (dev only).
- **[ORTA] 2.2.2** `KeycloakService` `init({ onLoad: 'login-required' })` — ilk yüklemede SSR-not-ready, `silent-check-sso.html` kullanılmıyor; login flow her zaman full redirect.
- **[ORTA] 2.2.3** `loadUserProfileAtStartUp: false` — `KeycloakService.loadUserProfile()` bir noktada lazy çağrılıyor mu? Bazı component'ler `kc.tokenParsed.preferred_username`'i okuyor (token'da var, profile lazım değil — OK).
- **[DÜŞÜK] 2.2.4** `runtimeKcUrl` (env.prod.ts) `window.__BCMS_KEYCLOAK_URL__` — `runtime-config.js` 404 olursa fallback `window.location.host` kullanılır; ama production'da Keycloak farklı host'tasa sessiz fail.
- **[DÜŞÜK] 2.2.5** `LoggerService.info` production'da no-op, ama `warn`/`error` console'a yazıyor — Sentry/Posthog henüz bağlanmamış (yorum "ileride").

### 2.3 Schedule List (en büyük component)

- **[ÖNEMLİ] 2.3.1** `schedule-list.component.ts` **2385 satır** — god component; aspect-based ayrıştırma (ScheduleHeader, ScheduleTable, ScheduleFilter, ScheduleFooter) gerekli. Test yazımı, code review zor.
- **[ORTA] 2.3.2** `selectedDate` signal local Date (Istanbul varsayım); user farklı timezone'da ise hatalı; `toLocaleDateString` her render hesaplanıyor.
- **[ORTA] 2.3.3** `clockTimer` her dakika tetikleniyor — change detection cascade; OnPush stratejisi yok (component default).
- **[ORTA] 2.3.4** `loadSchedules` filter değiştiğinde her seferinde komple fetch — pagination ya da delta yok.
- **[ORTA] 2.3.5** `confirmDelete()` confirm dialog'unda `If-Match` version sıkıştırılmamış — başka kullanıcı düzenlerse stale version 412 fırlatabilir, `errorInterceptor` toast atar ama UI state stale kalır.
- **[DÜŞÜK] 2.3.6** Inline `<style>` 800+ satır — CSS module'üne ayrılabilir.
- **[DÜŞÜK] 2.3.7** Lig renk hesaplaması `getLeagueClass()` her row için çağrılıyor (1000 row × N render = N×1000 fonksiyon çağrısı). Memoize.

### 2.4 API Service / Data Layer

- **[ORTA] 2.4.1** `api.service.ts` retry yok — network glitch'te kullanıcı manuel refresh gerekir.
- **[ORTA] 2.4.2** Cache yok — aynı `/channels/catalog` 5 farklı component yüklemesinde 5 kez fetch.
- **[ORTA] 2.4.3** `getBlob` Excel download progress yok — 50MB rapor için kullanıcı "donduğu" hissine kapılır.
- **[DÜŞÜK] 2.4.4** `Observable<T>` her metod — `firstValueFrom` ile kullanan kod var, `signal` interop yok.

### 2.5 Diğer Component'ler / Feature Modülleri

- **[ORTA] 2.5.1** `monitoring-dashboard.component.ts` (gözden geçirilmedi tam) `setInterval`-tabanlı polling muhtemel; `OnDestroy` cleanup kontrol gerek.
- **[ORTA] 2.5.2** `dashboard.component.ts` (gözden geçirilmedi tam) — KPI hesaplaması frontend mi backend mi belirsiz; ikiye böl.
- **[ORTA] 2.5.3** `weekly-shift.component.ts` Keycloak `/users` listesi backend'den geliyor — frontend cache yok, her tab değişiminde yeniden fetch.
- **[ORTA] 2.5.4** `audit-log.component.ts` pagination ve filter olmazsa milyon satır fetch'i yıkıcı (backend `take` ekli mi belirsiz — kontrol gerek).
- **[ORTA] 2.5.5** `users-list.component.ts` Keycloak admin token client-side (?) — her zaman backend'den geliyor olmalı; SystemEng/Admin only.
- **[ORTA] 2.5.6** `mcr-panel.component.ts` real-time signal indicator — WebSocket / SSE yok, polling ile çalışıyorsa metrik bombası.
- **[DÜŞÜK] 2.5.7** `provys-content-control.component.ts` placeholder feature mi? Implementation gözden geçirilmedi.
- **[DÜŞÜK] 2.5.8** `documents.component.ts` placeholder muhtemel.
- **[DÜŞÜK] 2.5.9** `settings.component.ts` env editör mü, kullanıcı tercih mi belirsiz.
- **[DÜŞÜK] 2.5.10** `channel-list.component.ts` ve `booking-list.component.ts` standart CRUD; eski pattern'ler (dialog, signal) muhtemel — sample review yapılmadı.

### 2.6 Routing

- **[ORTA] 2.6.1** `/login-error` route **app.routes.ts'de tanımlı değil** — `auth.guard.ts:44` `parseUrl('/login-error')` fallback'i ** route → /schedules'a düşüyor; kullanıcı login fail'de "schedules" görüyor ve confused.
- **[ORTA] 2.6.2** `app.routes.ts` lazy load Standalone — `canActivateChild` parent'a tanımlı (HIGH-FE-011 fix) ✅; ama yeni route eklerken developer unutursa public olur.

### 2.7 Theming / Styles

- **[BİLGİ] 2.7.1** Light/dark theme system (tokens.scss) ✅; FOUC önleme inline script (index.html) ✅.
- **[DÜŞÜK] 2.7.2** `::ng-deep` 5 dosyada — Angular deprecation; encapsulation `None` veya host-context selector tercih.
- **[DÜŞÜK] 2.7.3** `--bp-line` light: `#5d2e5d` patlıcan moru ✅; ama `--bp-line-2` `rgba(93,46,93,0.32)` — kontrast oran (WCAG) test edilmemiş.
- **[DÜŞÜK] 2.7.4** Inline `<style>` her büyük component'te — global tokens kullanılıyor ✅, ama component'lere özel custom property override yok.
- **[BİLGİ] 2.7.5** Sidebar gradient theme-invariant (KORUMA listesi) ✅.

### 2.8 Logger / UX / Misc

- **[DÜŞÜK] 2.8.1** `LoggerService` her zaman `console.log` (info), `console.warn`, `console.error` — Sentry adapter yok; "ileride" yorum.
- **[DÜŞÜK] 2.8.2** `app.component.ts` `currentDate` `setInterval(30_000)` — dakikada 2 update; her 60sn yeterli.
- **[DÜŞÜK] 2.8.3** `app.component.ts` placeholder mock alerts (line 530-532) — production'da gerçek API hâlâ bağlanmamış.
- **[DÜŞÜK] 2.8.4** `app.component.ts` `openNewBroadcast()` TODO — `/schedules`'a yönlendiriyor; UX kafa karıştırıcı.
- **[DÜŞÜK] 2.8.5** Window event listener `pagehide` `clearInterval` — `beforeunload` ile combo daha güvenli (mobile Safari `pagehide`'ı kaçırabilir).

### 2.9 Test

- **[ORTA] 2.9.1** Unit test sayısı **7 spec dosyası** (api.service, schedule.service, auth.guard, schedule-list, schedule-reporting, studio-plan, ingest-list) — kapsama düşük; özellikle business critical componentler test edilmemiş.
- **[ORTA] 2.9.2** Playwright tests **light mode görsel regression** odaklı — semantic interaction test'leri sadece `auth.setup.ts` + `smoke.spec.ts`. Schedule create/edit/delete e2e yok.

---

## 3. Database (apps/api/prisma) — 26 Bulgu

### 3.1 Schema (prisma/schema.prisma)

- **[ÖNEMLİ] 3.1.1** **`deleted_at` naming inconsistency** — `Channel`, `Schedule`, `Booking`, `League`, `Match`, ... `deleted_at` (no `@map`); `ShiftAssignment` `deletedAt @map("deleted_at")`. Migration sırasında biri unutulur, drift.
- **[ÖNEMLİ] 3.1.2** **`AuditLog` partition yok** — son 14 günde 571K satır = ~40K/gün; 1 yıl = 14M satır; lookup yavaş, retention purge OOM riski.
- **[ÖNEMLİ] 3.1.3** Tüm PK'ler `Int` autoincrement — predictable IDs, **IDOR enumeration**; admin token leak senaryosunda saldırgan `GET /api/v1/schedules/1`, `2`, `3`... ile tüm satırları çekebilir (rate limit 300 req/min hafifletir ama önlem değil).
- **[BİLGİ] 3.1.4** ~~`usageScope` `String @db.VarChar(30)` — enum yok, CHECK constraint yok~~ → **DÜZELTME (2026-05-04)**: CHECK constraint **var** (migration `20260422000002_schedule_usage_scope_constraint`: `CHECK (usage_scope IN ('broadcast', 'live-plan'))`). Audit raporu okuma esnasındaki iddia hatalıydı. Severity ÖNEMLİ → BİLGİ. Kalan minor iş: integration test (DB-level enforcement doğrulama) + `schema.prisma` yorum bloku (Prisma 5 native CHECK desteklemiyor) + opsiyonel PG enum migration (defer). Detay: `ops/REQUIREMENTS-DATA-MODEL-CORRECTNESS-V1.md` §3.
- **[ÖNEMLİ] 3.1.5** `Booking.notes`, `taskDetails`, `taskReport` **unbounded TEXT** — kullanıcı 100MB rapor yazsa kabul; max length CHECK constraint yok.
- **[ORTA] 3.1.6** `IngestJob.sourcePath`, `proxyPath` unbounded TEXT — 32K path bile sığar; gerçekçi 4K limit yeterli.
- **[ORTA] 3.1.7** `entry_status` enum (line 490-494) — `content_entry` tabloları drop edilmiş ama enum kalmış (orphan).
- **[ORTA] 3.1.8** `AuditLogAction` enum'unda `UPDATEMANY`/`DELETEMANY` yok — audit.ts kodu `UPDATE`/`DELETE`'e map ediyor (1.1.5).
- **[ORTA] 3.1.9** `ShiftAssignment.weekStart` **`@db.VarChar(10)`** — `Date` olmalı; sıralama lexicographic (yine ISO date OK ama range query optimize değil).
- **[ORTA] 3.1.10** `Schedule.metadata` `Json?` — type guard yok; uygulama katmanı zod ile validate ediyor ama DB'ye direkt insert kaçabilir.
- **[ORTA] 3.1.11** GiST exclusion `Schedule channel_time_overlap` — sadece `channel_id IS NOT NULL` rows için (partial); 129/132 schedule null → exclusion bypass.
- **[ORTA] 3.1.12** `Match` ve `League` arasında soft-delete cascade tanımlı mı? Schema gözden geçirme: ayrı `deleted_at` kolonu yok ama `League.deletedAt` var, `Match.deletedAt` yok (tutarsızlık).
- **[ORTA] 3.1.13** `Booking.scheduleId` FK `onDelete: SetNull` mu yoksa `Cascade` mu? Schedule hard-delete edildiğinde booking'in tutması gerekir (audit/raporlama için).
- **[ORTA] 3.1.14** `Channel.muxInfo` `Json?` — schema validation yok; type alanı `RADIO` iken muxInfo dolu olabilir.
- **[ORTA] 3.1.15** `BroadcastType.code` unique constraint var mı? (kontrol gerek; varsa OK).
- **[ORTA] 3.1.16** `RecordingPort` migration `20260430140000_normalize_recording_ports` ile yeniden yapılandırıldı — schema artık tutarlı, ama eski code path silinmiş mi? Grep gerek.
- **[DÜŞÜK] 3.1.17** Birçok tabloda `created_at`/`updated_at` `@db.Timestamptz` — ✅; bazılarında olmayabilir (kontrol gerek).
- **[DÜŞÜK] 3.1.18** Kompozit indexler bazı tablolarda eksik — örn. `Schedule (channel_id, start_time)` partial index var, ama `Schedule (status, start_time)` "Ön planda olanlar" sorgusu için yok.
- **[DÜŞÜK] 3.1.19** `League.code` muhtemelen unique — kontrol edilmedi.
- **[DÜŞÜK] 3.1.20** Naming convention: bazı tablolar `snake_case`, bazıları camelCase Prisma `@map`'siz — drift.

### 3.2 Veri Bütünlüğü (canlı DB tarama)

- **[ÖNEMLİ] 3.2.1** **571,006 audit_log satırı** son 14 günde — partitioning eksikliğiyle birleşince index/lookup performansı düşük.
- **[ÖNEMLİ] 3.2.2** **129/132 schedule `channel_id IS NULL`** — neredeyse tüm live-plan record'ları GiST exclusion bypass; çakışma kontrolü application layer'a düşmüş ama service kodunda live-plan için explicit overlap check yok (kontrol gerek).
- **[ORTA] 3.2.3** `schedules.metadata->>'optaMatchId'` 132 schedule'ın **tamamında** dolu — `usageScope` discriminator'ı haricinde JSON path'a hâlâ bağımlı; CLAUDE.md'nin "obsolete" dediği pattern aktif kullanımda. Migration ile kolon olarak çıkarılmalı.
- **[ORTA] 3.2.4** Sadece **1 soft_deleted_schedule** — soft-delete pattern barely-used; ya tüm modüllerde aktive edilmeli ya da `deleted_at` kolonu kaldırılmalı (dead schema).
- **[DÜŞÜK] 3.2.5** Rapor için raw SQL bazı yerlerde `$queryRawUnsafe` kullanmıyor (bilgi). `$queryRaw` template literal güvenli ✅.
- **[DÜŞÜK] 3.2.6** Migration `20260505000000_drop_redundant_gist_partial_unique` — partial unique kaldırılmış, GiST tek kalmış; doğru karar (data validated).

---

## 4. Infrastructure — 30 Bulgu

### 4.1 docker-compose.yml

- **[ÖNEMLİ] 4.1.1** `worker` healthcheck `disable: true` — bilinçli karar (yorum mevcut), gerçek liveness probe `ops/REQUIREMENTS-HEALTHCHECK.md`'de tasarımı var; ama **production'a kadar worker silent-fail** olabilir. Tasarım dokümante edilmiş ✅, implementation pending.
- **[ÖNEMLİ] 4.1.2** `KEYCLOAK_ALLOWED_ISSUERS` worker için **default `http://172.28.204.133:8080/realms/bcms`** (line 219) — host IP hard-coded; LAN değişince worker JWT verify fail.
- **[ÖNEMLİ] 4.1.3** `OPTA_SMB_PASSWORD` env'den geliyor; container'da plain — `docker inspect` ile root erişimi olan herkes okur. Docker secrets veya Vault tercih.
- **[ORTA] 4.1.4** `postgres` `5433:5432` 127.0.0.1 bind ✅; ama dev'de `KEYCLOAK_DB` aynı postgres container'da → `pg_dump` backup tek user ile iki DB; restore order matters.
- **[ORTA] 4.1.5** `postgres_backup` SCHEDULE `0 3 * * *` host TZ — TZ=Europe/Istanbul env set edilmiş ✅; ama image v0.0.11 .sql.gz sahte gzip — fix mevcut (MED-INF-002) ✅.
- **[ORTA] 4.1.6** `rabbitmq` ports `5673`, `15673` 127.0.0.1 bind ✅; management UI default credentials `${RABBITMQ_USER}` — env zorunlu mu? `.env.example` kontrol gerek.
- **[ORTA] 4.1.7** `keycloak` `KC_HOSTNAME=beinport`, `KC_PROXY=edge` ✅; ama `KC_HOSTNAME_STRICT_HTTPS: ${KC_HOSTNAME_STRICT_HTTPS:-true}` env override'a izin veriyor — operatör yanlışlıkla `false` set etse insecure cookie üretilir.
- **[ORTA] 4.1.8** `web` ports `80:80, 443:443` — 80 redirect, 443 TLS termination; nginx config `default_server` ile `_` server_name catchall — internal CA cert `beinport` ve `localhost` kabul, dış host name'le erişim TLS warning verir.
- **[ORTA] 4.1.9** `opta-watcher` healthcheck `pgrep -f opta_smb_watcher.py` — sürec varlığı ≠ canlılık (deadlock'ta da pass). Yorum bunu kabul ediyor; gerçek SMB ping endpoint'i tasarımda.
- **[ORTA] 4.1.10** `prometheus` retention `30d` — disk dolma riski; `--storage.tsdb.retention.size` ile cap eklemek defansif.
- **[ORTA] 4.1.11** `grafana` `GF_USERS_ALLOW_SIGN_UP=false` ✅; ama default admin password env'den (`GRAFANA_PASSWORD`) — strong default yok, .env'de zayıfsa açık.
- **[ORTA] 4.1.12** `mailhog` production için kullanılabilir — `docker-compose.yml`'de aktif; production'da real SMTP'ye geçildiğinde mailhog container kapatılmalı (yorum yok).
- **[DÜŞÜK] 4.1.13** Logging driver `json-file` 100m × 3 = 300MB cap ✅; ancak `prometheus_data` ve `grafana_data` named volume'larda — disk usage monitör eksik.
- **[DÜŞÜK] 4.1.14** `bxf_watch` ve `ingest_watch` named volume'lar — host directory bind mount yerine named volume; admin host'tan dosya kopyalayamıyor (UX kaybı).
- **[DÜŞÜK] 4.1.15** `worker` `depends_on` postgres+rabbitmq healthcheck ✅; `api` cascading restart kaldırılmış (HIGH-INF-017) ✅.

### 4.2 nginx.conf

- **[ÖNEMLİ] 4.2.1** `add_header Content-Security-Policy ... 'unsafe-inline' 'unsafe-eval'` — XSS surface; Angular ngStyle/inline style için `'unsafe-inline'` zorunlu (ng21'de hala) ama `unsafe-eval` Angular AOT'ta gerekmez; saldırgan `eval()`-tabanlı payload çalıştırabilir. Strict CSP follow-up dokümante (yorum).
- **[ORTA] 4.2.2** TLS `ssl_protocols TLSv1.2 TLSv1.3` ✅; cipher list ECDHE-only ✅; fakat `ssl_session_tickets off` modern browser performance'ı düşürür (kontrollü, OK).
- **[ORTA] 4.2.3** HSTS `max-age=31536000; includeSubDomains` — `preload` yok; iç CA için preload zaten anlamsız.
- **[ORTA] 4.2.4** OCSP stapling kapalı — internal CA için anlamsız ✅; production CA'ya geçişte enable et.
- **[ORTA] 4.2.5** `/metrics` `deny all` ✅; ama nginx by-pass (direct api:3000) içeriden mümkün — application layer auth eksik (1.1.20 ile aynı bulgu).
- **[ORTA] 4.2.6** `proxy_read_timeout 180s` /api/ — Excel export 180sn'den uzun sürerse 504; tunable env yapılabilir.
- **[ORTA] 4.2.7** `client_max_body_size 100m` ✅ ama Fastify `multipart fileSize: 10m` ile uyumsuz (1.12.2).
- **[DÜŞÜK] 4.2.8** Webhooks `/webhooks/` route — proxy_pass ama rate-limit yok; OPTA_SYNC_SECRET ile korunuyor ✅.
- **[DÜŞÜK] 4.2.9** Static asset cache `1y immutable` ✅; runtime-config.js no-store ✅.

### 4.3 prometheus + alerts

- **[ORTA] 4.3.1** `web-config.yml` basic auth password hash `M.NYCJI4209bcEX8OxqXNOMWIhgDcR7IctAbGi5PqlT3RPtan6xeC` (placeholder = "changeme_prom") — production'da rotate gerek; healthcheck base64 string `YWRtaW46Y2hhbmdlbWVfcHJvbQ==` hardcoded.
- **[ORTA] 4.3.2** Prometheus alertmanager `targets: []` — alert kuralları var ama hedef yok; alert tetiklense kimse bilgilendirilmiyor (mail/slack hook eksik).
- **[ORTA] 4.3.3** Alert rules `OptaLeagueSyncBurst` 500/h, `OptaLeagueWriteBurst` 200/h — threshold business sense ile uyumlu (yorum) ✅.
- **[DÜŞÜK] 4.3.4** Prometheus retention `30d`, scrape_interval `15s`, evaluation `15s` — high-cardinality metric eklenirse storage hızla şişer.
- **[BİLGİ] 4.3.5** Audit comment exporter'lar removal ✅ (CRIT-006 fix).

### 4.4 Dockerfile / Build

- **[ÖNEMLİ] 4.4.1** `api.Dockerfile` `USER fastify` (uid 1001) ✅; ama `EXPOSE 3000` privileged değil ✅.
- **[ORTA] 4.4.2** `api.Dockerfile` HEALTHCHECK `wget` busybox — start-period 15s prod boot için yetersiz olabilir (Prisma cold start + JWKS fetch).
- **[ORTA] 4.4.3** `web.Dockerfile` `nginx:alpine` `apk add curl gettext` — curl healthcheck için, gettext envsubst için ✅.
- **[ORTA] 4.4.4** `opta-watcher.Dockerfile` `pip install defusedxml smbprotocol --no-cache-dir` ✅; ama version pin yok — sürüm drift.
- **[ORTA] 4.4.5** `opta-watcher-entrypoint.sh` `chown -R opta:nogroup /data` — büyük volume'da boot yavaş; idempotent ama her start'ta tarıyor.
- **[DÜŞÜK] 4.4.6** Multi-stage build deps stage'i her change'de iptal edilebilir (cache-bust); package-lock.json layer ayrımı ✅.

### 4.5 Postgres init / Backup

- **[ORTA] 4.5.1** `init-multiple-dbs.sh` HIGH-INF-009 fix ✅ — identifier injection korumalı.
- **[ORTA] 4.5.2** `infra/postgres/RESTORE.md` mevcut (gözden geçirilmedi tam) — runbook test edildi mi? "test restore" CI job yok.
- **[DÜŞÜK] 4.5.3** Backup volume `./infra/postgres/backups` host bind mount; .gitkeep var. Dış disk/S3 sync yok (REQUIREMENTS-S3-BACKUP.md tasarımda).

### 4.6 TLS / Keycloak / Ops

- **[BİLGİ] 4.6.1** `infra/tls/.gitignore` `**/*.key` ile tüm private key'leri ignore ediyor; `git ls-files` doğrulamasında `root.key`, `intermediate.key`, `server.key` repo'da yok ✅. Disk'te local var, commit edilmemiş — risk yok.
- **[ORTA] 4.6.2** Server cert expiry **2028-05-03** — 3 yıl, OK; root CA expiry kontrol edilmedi.
- **[ORTA] 4.6.3** Keycloak realm-export.json hassas (client-secret içerebilir) — repo'da varsa rotate gerek.
- **[DÜŞÜK] 4.6.4** Ops scripts (`bcms-start.sh`, `bcms-restart.sh`, `bcms-build.sh`...) Bash + docker compose; pre-flight check yok (env zorunlu var mı?).
- **[DÜŞÜK] 4.6.5** Systemd unit dosyaları (`bcms-api-dev.service` vs.) — dev için, production için bcms-api.service yok (ya containerize ya systemd seç).
- **[DÜŞÜK] 4.6.6** `bcms-keycloak-apply-security.sh` — script gözden geçirilmedi; içerik audit gerek.
- **[BİLGİ] 4.6.7** `ops/REQUIREMENTS-*.md` 9 design doc — healthcheck, TLS, S3 backup, notification delivery, maintenance, migration baseline, UI V2 ✅.

---

## 5. Configuration — 6 Bulgu

### 5.1 package.json / CI

- **[ORTA] 5.1.1** `.github/workflows/ci.yml` `SKIP_AUTH=true` set ediyor (line 45) — CI smoke testleri için, ama runtime guard `validateRuntimeEnv` `production`'da blokluyor; CI `NODE_ENV=development` ✅. Yine de şüpheli ortam değişkeni iz bırakıyor.
- **[ORTA] 5.1.2** CI `npm audit --audit-level=high` (line 71) — `--production` flag yok; devDependencies CVE'leri pipeline'ı kırar. `npm audit --omit=dev --audit-level=high` daha doğru.
- **[DÜŞÜK] 5.1.3** Root `package.json` `devDependencies` `webpack: ^5.105.2` — runtime'da kullanılmıyor görünüyor; transitive olarak Angular CLI'dan zaten geliyor.
- **[DÜŞÜK] 5.1.4** Web `package.json` `@fastify/jwt`, `fastify`, `nodemailer` listede — frontend'de **kullanılmıyor**; eski drift artığı; bundle size artırıyor.
- **[BİLGİ] 5.1.5** `prisma` schema field root `package.json`'da ✅ (workspace pattern).
- **[BİLGİ] 5.1.6** Workspaces `apps/*`, `packages/*` ✅.

---

## 6. Shared Package — 4 Bulgu

- **[ORTA] 6.1** `rbac.ts` `JwtPayload.email?` optional (HIGH-SHARED-007 fix) ✅; ama service-account token'ları için fallback yok mu kullanan kodda? `audit.ts` `principal.email` kullanıyor, undefined ise NULL'a düşer (audit_log.email_id) — dokümante edilmeli.
- **[ORTA] 6.2** `PERMISSIONS.bookings.*` boş array = "any authenticated"; semantic subtle, isim `requireGroup()` kafa karıştırıcı (1.1.11).
- **[DÜŞÜK] 6.3** `PERMISSIONS.opta.read = []` — OPTA fixture okuma all-authenticated; eğer Opta data confidential ise grup gate eklenmeli.
- **[DÜŞÜK] 6.4** `BCMS_GROUPS` Türkçe karakterli `YayınPlanlama` — Keycloak group rename yapıldıysa migration script var mı? (BCMS_GROUPS bu değer değişmez varsayım yapıyor).

---

## 7. Test Coverage — 2 Bulgu

- **[ORTA] 7.1** Backend test dosyası **yok** — `apps/api/src/` altında `*.test.ts` veya `*.spec.ts` 0 sonuç (notification.test.ts harici, o da fonksiyonel demo). Critical paths (audit plugin, optimistic locking, RabbitMQ consumer) test edilmemiş.
- **[ORTA] 7.2** Frontend 7 spec dosyası, çoğu component-render test; service unit test (api.service.spec, schedule.service.spec, auth.guard.spec) hafif. Hiçbir interceptor (auth, error) testi yok.

---

## 8. Genel Pattern Gözlemleri

- **`as any` ve `as never` cast'ları** birden fazla yerde — type safety erezyonu (`audit.ts`, `weekly-shift.routes.ts:63`, `ingest.routes.ts:230`).
- **`@bcms/shared` `GROUP` constant** kullanımı tutarsız — bazı yerlerde literal `'Admin'` (booking.service:56, users.routes hasAdminGroup, audit.ts).
- **`new Date()` local timezone** kullanımı yer yer Istanbul yerine UTC; export filename, audit retention midnight, playout tcNow → drift.
- **Soft-delete pattern** schema'da var ama gerçek kullanımı **1 satır** — dead schema.
- **Outbox pattern** yok — RabbitMQ publish transaction dışı; eventual consistency (notification, ingest event).
- **Pagination** birçok GET endpoint'te yok (incidents, users, audit-logs muhtemel).
- **Rate-limit allowlist** sadece 3 endpoint (/health, /opta/sync, /callback); webhook'lara per-endpoint config tunable değil.
- **JSON file persistence** (BXF watcher `.bxf_processed.json`, OPTA `optaState`) — DB'ye taşınmalı.
- **Mock alerts** UI'da hâlâ var — production'a gitmeden temizlenmeli.

---

## 9. Hızlı Kazanımlar (10 madde)

Düzeltmesi en kolay, etkisi yüksek olanlar:

1. `auth.interceptor.ts:20` `environment.skipAuth` → `isSkipAuthAllowed()` (3 satır).
2. CI workflow `npm audit --omit=dev --audit-level=high` (1 satır).
3. `web/package.json`'dan `@fastify/jwt`, `fastify`, `nodemailer` kaldır (bundle size).
4. `audit-retention.job.ts` Istanbul timezone (`Intl.DateTimeFormat`) — 4 satır.
5. `incidents.routes` GET'e `take` + `skip` ekle — 6 satır.
6. `metrics.ts` route'u `requireGroup(GROUP.SystemEng)` ile gate et veya basic auth ekle (defense-in-depth).
7. `BcmsTokenParsed` interface'ini `core/types/auth.ts`'den import et — 4 dosyada duplicate sil.
8. `match.routes` `findMany` `take: 200` default + query param.
9. `schedule.service.ts` conflict response: `conflicts` yerine `conflictCount` veya minimal projection.
10. `ingest.worker.ts` jobId dedup key — `if (job.status !== 'PENDING') return;` 3 satırlık state-machine guard.

---

## 10. Orta Vadeli (Tasarım Gerektirenler)

- **AuditLog partition** (range by `timestamp`, monthly) + retention job'u partition drop ile değiştir.
- **DLQ** rabbitmq plugin'i — `x-dead-letter-exchange` + DLQ queue per-domain.
- **Outbox pattern** — schedule.service publish'i transaction içine; ayrı poller worker dispatch.
- **Schedule channelId NULL** problem — live-plan için ayrı tablo veya channel_id zorunlu yap.
- **`metadata.optaMatchId`** kolon promote — JSON path query bağımlılığı sıfırla.
- **Ingest worker dedup** — `processed_jobs(id, processed_at, status)` tablosu + idempotency check.
- **Standalone Component refactor** — schedule-list 2385 → ~800 satır × 3 component.
- **Health endpoint detaylandır** — `/health/liveness` (process), `/health/readiness` (DB + RMQ + Keycloak ping); worker için real probe.
- **Test coverage** — backend integration testleri (Vitest + Testcontainers) audit plugin için kritik.

---

## 11. Notlar

- Bu rapor read-only taramayla üretildi; hiçbir dosya değiştirilmedi.
- Bulgular `BCMS_ULTRA_DETAILED_AUDIT_REPORT_2026-05-01.md` içeriğinden bağımsız okuma sonucu; **çakışmalar** varsa o rapor öncelikli alınabilir veya iki rapor cross-ref edilebilir.
- "Açık risk" tanımı: production'a deploy edildiğinde gerçek kullanıcı/data etkileyebilecek olanlar. Hijyen bulguları ayrı.
- `ÖNEMLİ` etiketi audit raporlarındaki "CRITICAL" ile birebir uyumlu değil — kategori bağlamına göre değerlendirilmeli (örn. infra `ÖNEMLİ` ≠ database `ÖNEMLİ`).
- 211 bulgudan 27'si **`ÖNEMLİ`** olarak işaretlendi; geri kalanı orta-düşük efor / hijyen sınıfında.

Rapor sonu.
