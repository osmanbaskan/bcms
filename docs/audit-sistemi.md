# Audit (Denetim) Sistemi — Uçtan Uca

> Bu doküman audit sisteminin **tamamını** anlatır: yazma işlemlerinin nasıl yakalandığı, nerede
> saklandığı, nasıl görüntülendiği ve **neyi yakalamadığı**. UI tarafı için
> [`sekmeler/audit-loglari.md`](sekmeler/audit-loglari.md), arka plan job'ları için
> [`worker-watcher/audit-retention.md`](worker-watcher/audit-retention.md) ve
> [`worker-watcher/audit-partition.md`](worker-watcher/audit-partition.md) tamamlayıcıdır.
>
> Kaynak: kod tabanı (canlı doğrulama). Son güncelleme: 2026-06-03.

---

## 1. Amaç

Sistemdeki **her veri değişikliğini** "kim, ne zaman, hangi varlığı, nasıl değiştirdi" sorularına
cevap verecek şekilde kayıt altına almak. Her kayıt değişiklik öncesi (`before`) ve sonrası (`after`)
durumu JSON olarak tutar. Yakalama **otomatiktir** — geliştiricinin her route'a tek tek "audit yaz"
demesi gerekmez; Prisma katmanında merkezi olarak yapılır.

---

## 2. Üç parça (genel akış)

```
   ┌──────────────────────── 1) YAKALAMA ────────────────────────┐
   │  HTTP isteği → auth → route handler → Prisma write           │
   │       │                                   │                  │
   │  AsyncLocalStorage (ALS)            Prisma $extends           │
   │  request context: user, ip         write'ı intercept eder    │
   │       │                            before/after snapshot alır │
   │       └──────────► pendingAuditLogs[] kuyruğu ◄───────────────┤
   │                              │                                │
   │   onSend hook (yalnız 2xx/3xx): kuyruğu audit_logs'a yazar    │
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────── 2) SAKLAMA ─────────────────────────┐
   │  audit_logs  (production'da timestamp'e göre AYLIK partition) │
   │   • audit-partition job → gelecek aylar için partition açar   │
   │   • audit-retention job → 90 günden eski partition'ı DROP eder│
   └──────────────────────────────┬───────────────────────────────┘
                                  ▼
   ┌──────────────────────── 3) GÖRÜNTÜLEME ─────────────────────┐
   │  GET /api/v1/audit (SystemEng) → "Audit Logları" sekmesi      │
   │  filtre: entity, action, kullanıcı, tarih; before/after görür │
   └──────────────────────────────────────────────────────────────┘
```

---

## 3. Yakalama — Prisma `$extends` audit extension

**Dosya:** `apps/api/src/plugins/audit.ts`

### 3.1 Request context (AsyncLocalStorage)

Her HTTP isteği bir ALS "store" içinde çalışır. İki Fastify hook'u doldurur:

- **`onRequest`** → `als.run({ ipAddress, pendingAuditLogs: [] })` ile store'u kurar; tüm request
  yaşam döngüsünü sarar.
- **`preHandler`** → auth doğrulandıktan **sonra** çalışır; JWT'den `userId = user.sub` ve
  `userRoles = user.groups` doldurur.

Bu sayede audit kaydı, isteği yapan kullanıcıyı ve IP'yi bilir.

### 3.2 Yazma işlemlerini yakalama

Extension `$allModels.$allOperations` ile **tüm Prisma modellerindeki tüm operasyonları** sarar:

- **`AuditLog` modelinin kendisi atlanır** → sonsuz döngü (audit'i audit'leme) engellenir.
- Sadece **yazma** operasyonları işlenir:
  `create, update, upsert, delete, createMany, updateMany, deleteMany`. Okuma (`findMany` vb.)
  dokunulmadan geçer.

### 3.3 before/after snapshot

| Operasyon | `before` (öncesi) | `after` (sonrası) |
|-----------|-------------------|--------------------|
| `create` / `upsert` | — | yazılan kayıt (`result`) |
| `update` | `findFirst({where})` | yazılan kayıt |
| `delete` | `findFirst({where})` | — |
| `updateMany` / `deleteMany` | `findMany({where})` ile **tüm etkilenen satırlar** | — |
| `createMany` | — | — (toplu) |

Her etkilenen satır için ayrı bir audit kaydı üretilir (bulk'ta `affectedIds` üzerinden tek tek).

### 3.4 İki yazım bağlamı

- **HTTP bağlamı (ALS store var):** audit kayıtları hemen yazılmaz; `pendingAuditLogs[]` kuyruğuna
  eklenir, **`onSend` hook'unda toplu** yazılır.
- **Worker / arka plan bağlamı (ALS store yok):** istek yok demektir; kayıt **anında** yazılır
  (`base.auditLog.createMany`). Kullanıcı bilinmediği için `user = 'system'` olur.

### 3.5 Phantom-write koruması (önemli tasarım)

`onSend` hook'u kuyruğu DB'ye yazmadan önce yanıt durumunu kontrol eder:

- **`statusCode >= 400` ise audit YAZILMAZ.** Yani bir `$transaction` rollback olup 5xx dönerse,
  veri aslında değişmediği için audit de oluşmaz → **"hayalet" (phantom) kayıt yok.**
- Audit flush'ın kendisi hata verirse istek bilinçli olarak **500**'e düşürülür
  (`Audit log flush failed`) — sessizce kayıt kaybı olmaz.

### 3.6 Bulk güvenliği — `MAX_BULK_AUDIT_ROWS = 1000`

Büyük `updateMany/deleteMany` (örn. on binlerce satır) tüm before-snapshot'ı belleğe çekerse OOM
riski doğar. Bu yüzden ilk **1000** satır snapshot'lanır, fazlası cap'lenir (`bulkTruncated`,
operatöre `warn` log). `entityId` tespit edilemeyen (composite-PK) nadir durumda `0` ile yazılır +
`warn` log.

---

## 4. Veri modeli

**Tablo:** `audit_logs` — model `AuditLog` (`apps/api/prisma/schema.prisma`)

| Kolon | Tip | Açıklama |
|-------|-----|----------|
| `id` | `Int` autoincrement | — |
| `entity_type` | `varchar(50)` | Model adı (örn. `Schedule`, `LivePlanEntry`) |
| `entity_id` | `Int` | Etkilenen kaydın PK'sı (bulk cap'te `0` olabilir) |
| `action` | enum `audit_log_action` | `CREATE, UPDATE, DELETE, UPSERT, CREATEMANY` |
| `before_payload` | `Json?` | Değişiklik öncesi tam kayıt |
| `after_payload` | `Json?` | Değişiklik sonrası tam kayıt |
| `user` | `varchar(100)` | JWT `sub` ya da `system` |
| `ip_address` | `varchar(45)?` | İsteği yapan IP (IPv6 dahil) |
| `timestamp` | `timestamptz(6)` default `now()` | Olay anı (UTC instant) |

- **Composite PK:** `@@id([id, timestamp])` — partition anahtarı `timestamp` olduğu için PK'ya dahil
  edilmek **zorunda** (Postgres partition kuralı).
- **İndeksler:** `(entity_type, entity_id)`, `(user)`, `(timestamp)`.
- **Action eşlemesi (extension):** `createMany→CREATEMANY`, `updateMany→UPDATE`,
  `deleteMany→DELETE`, diğerleri `operation.toUpperCase()`.

---

## 5. Saklama — partition + retention

Production'da `audit_logs`, `timestamp`'e göre **RANGE ile aylık partition'lı** bir tablodur
(`audit_logs_YYYY_MM` + taşma için `audit_logs_default`). Dev/test'te düz (regular) tablodur.

### 5.1 Partition önden açma — `audit-partition` job

**Dosya:** `audit-partition.job.ts` · **Container:** worker

- Boot'ta bir kez, sonra **24 saatte bir** çalışır.
- `monthsAhead(now, 4)` → **mevcut ay + 3 ileri ay** için partition oluşturur
  (`CREATE TABLE IF NOT EXISTS`, idempotent). Böylece insert'ler partition eksikliğinden fail olmaz.
- Tablo partitioned değilse (dev/test) **no-op + warn**.
- Dry-run: `AUDIT_PARTITION_DRY_RUN=true`.

### 5.2 Eskiyi temizleme — `audit-retention` job

**Dosya:** `audit-retention.job.ts` · **Container:** worker

- Boot'ta bir kez, sonra **24 saatte bir** (TR gün başına hizalı).
- `cutoff = bugün − AUDIT_RETENTION_DAYS` (**default 90 gün ≈ 3 ay**, TR saatiyle hesaplanır).
- **İki strateji (otomatik seçilir):**
  - **Partitioned tablo →** `rangeEnd ≤ cutoff` olan ayları **komple `DROP TABLE`** eder. Anında,
    satır kilidi yok, tablo şişmez. (Tercih edilen yol.)
  - **Regular tablo (dev/test) →** `deleteMany({ timestamp: { lt: cutoff } })` fallback.
- Dry-run: `AUDIT_RETENTION_DRY_RUN=true` → sadece kaç satır/partition silineceğini loglar.

> **Karar (2026-06-03):** Saklama **3 ay** olarak sabitlendi — `.env`'de `AUDIT_RETENTION_DAYS=90`.

---

## 6. Görüntüleme — UI + API

| Katman | Değer |
|--------|-------|
| **Nav** | YÖNETİM > Audit Logları (ikon `history`) |
| **Route / bileşen** | `/audit-logs` → `AuditLogComponent` (`apps/web/src/app/features/audit/`) |
| **API** | `GET /api/v1/audit` (`audit.routes.ts`) |
| **Yetki** | `PERMISSIONS.auditLogs.read = ['SystemEng']` (Admin bypass) |

**Filtreler (Zod doğrulamalı):** `entityType`, `entityId`, `action`, `user` (contains, büyük/küçük
harf duyarsız), `from`/`to` (ISO datetime), `page` (≥1), `pageSize` (≤500, default 100). Sonuç
`timestamp` azalan sıralı; `{ data, total, page, pageSize, totalPages }` döner.

---

## 7. ⚠️ Sistemin yakalamadıkları (kritik boşluklar)

Audit yalnızca **Prisma model operasyonlarını** görür. Aşağıdakiler **kayda GİRMEZ**:

1. **Raw SQL** — `$queryRaw` / `$executeRaw(Unsafe)` ile yapılan INSERT/UPDATE/DELETE.
2. **`TRUNCATE`** — tüm tabloyu temizler, extension hiç devreye girmez.
3. **Migration / DBA müdahalesi** — `psql`, migration script'leri, manuel SQL.
4. **Partition `DROP`** — retention'ın kendi temizliği audit'lenmez (kasıtlı, sonsuz döngü olmaması için
   `AuditLog` modeli zaten atlanır).
5. **Bulk > 1000 satır** — before-snapshot ilk 1000 ile cap'lenir (`bulkTruncated`).
6. **Başarısız istekler (≥400 / rollback)** — kasıtlı olarak yazılmaz (phantom-write koruması).

> **2026-06-01 olayı:** Bir entegrasyon testi `cleanupTransactional` canlı DB'ye bağlanıp `TRUNCATE`
> attı; lookup + technical_details satırları **audit'te hiç iz bırakmadan** silindi. Çünkü TRUNCATE
> Prisma extension'ını atlar. Kök neden buydu; o yüzden yedekler (audit değil) tek doğru kaynaktı.
> Koruma için `truncate-guard.ts` eklendi (canlı DB'ye TRUNCATE'i bloklar). Bkz CLAUDE.md
> "Raw SQL yasağı".

**Sonuç:** Audit, uygulama üzerinden yapılan değişiklikler için güvenilirdir; **veri kaybı
araştırmasında tek başına yeterli değildir** — günlük DB yedekleri otoriterdir.

---

## 8. İşletim — ayarlar (env)

| Değişken | Default | Etki |
|----------|---------|------|
| `AUDIT_RETENTION_DAYS` | `90` | Kaç gün saklanacağı (cutoff). `.env`'de 90 sabit. |
| `AUDIT_RETENTION_DRY_RUN` | `false` | `true` → silmez, sadece loglar |
| `AUDIT_PARTITION_DRY_RUN` | `false` | `true` → partition oluşturmaz, sadece loglar |
| `BCMS_BACKGROUND_SERVICES` | (worker) | `audit-retention`, `audit-partition` bu listede olmalı |

Her iki job `service-heartbeat` ile izlenir (günlük; expected 24h, stale 25h).

---

## 9. Olay geçmişi

- **2026-06-01** — Entegrasyon testi canlı DB'ye TRUNCATE attı; lookup + tech_details iz bırakmadan
  silindi (audit yakalayamadı). 06-01 yedeğinden seçici kurtarma yapıldı. `truncate-guard.ts` eklendi.
- **2026-06-03** — Saklama politikası **3 ay** olarak sabitlendi (`AUDIT_RETENTION_DAYS=90`, `.env`).
  Donmuş eski `audit_logs_legacy` tablosu (571.104 satır, Nis 21–May 8, 102 MB) önce soğuk arşive
  yedeklendi (`infra/postgres/backups/archive/audit_logs_legacy_predrop_20260603.sql.gz`), sonra
  DROP edildi → DB 206 → 104 MB. **May 8 öncesi audit geçmişi artık yalnız o arşivde.**

---

## 10. İlgili kod ve dökümanlar

| Konu | Yer |
|------|-----|
| Yakalama (extension + ALS + hook'lar) | `apps/api/src/plugins/audit.ts` |
| Tablo modeli + enum | `apps/api/prisma/schema.prisma` (`model AuditLog`, `enum AuditLogAction`) |
| API endpoint | `apps/api/src/modules/audit/audit.routes.ts` |
| Retention job + helper | `audit-retention.job.ts`, `audit-retention.helpers.ts` |
| Partition job + helper | `audit-partition.job.ts`, `audit-partition.helpers.ts` |
| TRUNCATE koruması | `apps/api/src/lib/truncate-guard.ts` |
| UI sekmesi | [`sekmeler/audit-loglari.md`](sekmeler/audit-loglari.md) |
| Retention job (özet) | [`worker-watcher/audit-retention.md`](worker-watcher/audit-retention.md) |
| Partition job (özet) | [`worker-watcher/audit-partition.md`](worker-watcher/audit-partition.md) |
| Ops gereksinim/runbook | `ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md`, `ops/RUNBOOK-AUDITLOG-PARTITION-DEPLOY.md` |
