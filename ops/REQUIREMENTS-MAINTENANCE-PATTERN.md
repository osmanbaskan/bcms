# Audit-Traced Maintenance Pattern — Tasarım Gereksinimleri

> **Status**: 📋 Requirements doc (implement edilmedi). Implement ayrı tur(lar), kullanıcı kararları + audit pipeline prerequisite verify gelene kadar bekliyor.
> **Audit referansı**: `BCMS_AUDIT_REPORT_2026-05-01.md` Section 4 — Data Cleanup Decisions; bu pattern olmadan write-deferred kalan üç item.
> **Pattern referansı**: `ops/REQUIREMENTS-S3-BACKUP.md` (`9925422`) ve `ops/REQUIREMENTS-NOTIFICATION-DELIVERY.md` (`9be627a`) — design-first, decisions-pending yapısının üçüncüsü.

## Amaç

Üç bekleyen veri-cleanup decision item'ı **aynı blokaja** bağlı:

| Item | Açıklama |
|---|---|
| `schedules.id=32` | Tek soft-deleted satır; canonical-make ya da hard delete kararı bekliyor |
| 3 orphan `ingest_plan_items` (54, 107, 108) | Port/job/qc/incidents bağlantısız satırlar; cleanup bekliyor |
| MED-001 soft-delete schema redesign | 21 tabloda `deleted_at` kolonu drop migration; `schedules.id=32` decision sonrasına bağlı |

Üçü de production veriye yazma gerektiriyor. BCMS proje kuralı (`CLAUDE.md`):
> "All writes MUST go through the Prisma `$extends` audit plugin in `apps/api/src/plugins/audit.ts`. Never disable it. Never use raw SQL (`$queryRaw`) for INSERT, UPDATE, or DELETE."

İki bilinen bypass riski:
- **Raw SQL** `DELETE`/`UPDATE` proje kuralı doğrudan ihlali (audit_logs satırı yazılmaz)
- **Standalone `new PrismaClient()` script** `$extends`'li factory'yi bypass eder; audit plugin uygulanmamış olduğu için audit pipeline çalışmaz

Bu pattern, audit-traced maintenance ops için **canonical entry-point** belirler. Pattern kurulduktan sonra üç item de güvenle uygulanabilir.

---

## 1. Mevcut Audit Pipeline Analizi (read-only verify)

### `apps/api/src/plugins/audit.ts` özet

| Konsept | Lokasyon | Detay |
|---|---|---|
| `als` (AsyncLocalStorage) | line 23, **module-level export** | Maintenance command direkt import edebilir; `als.run(...)` ile context push edilir |
| `RequestContext` interface | line 16-21 | Field'lar: `userId?`, `userRoles?`, `ipAddress?`, `pendingAuditLogs[]` |
| HTTP request context push | `contextPlugin` line 30-32 | `als.run({ ipAddress: request.ip, pendingAuditLogs: [] }, done)` |
| HTTP auth context fill | line 34-42 | `preHandler` hook'unda `userId`, `userRoles` doldurulur (auth verify sonrası) |
| Audit interceptor (`buildAuditExtension`) | line 56-122 | `$extends` ile tüm write op'lara hook |
| **Worker (non-HTTP) fallback** | line 112-115 | "ALS store yoksa anında yazılır" — `await base.auditLog.createMany({ data: ... })` |
| HTTP onSend flush (phantom write koruması) | line 154-166 | Sadece 2xx/3xx response'larda audit yazılır; rollback → audit dropped |

### `AuditEntry` interface (line 6-14)
```ts
interface AuditEntry {
  entityType: string;
  entityId: number;
  action: AuditLogAction;
  beforePayload?: any;
  afterPayload?: any;
  user: string;
  ipAddress?: string;
}
```
**Field eksikleri (kritik)**: `metadata` yok, `reason` yok, `requestedBy` yok, `operation` yok.

### `toDbRow` (line 131-141)
DB'ye yazılan row'da sadece şu field'lar: `entityType, entityId, action, beforePayload, afterPayload, user, ipAddress`. **`audit_logs` tablosunda da sadece bu kolonlar var** (live psql verify, `\d audit_logs`).

---

## 2. Kritik Prerequisite'ler (verify sonucu)

### Prerequisite (a) — ALS audit context push API ✅ **HAZIR**

`als` zaten export ediliyor (audit.ts:23). Maintenance command direct import edebilir:
```ts
import { als } from 'apps/api/src/plugins/audit';

await als.run(
  { userId: 'maintenance-bot', userRoles: ['Admin'], ipAddress: '127.0.0.1', pendingAuditLogs: [] },
  async () => {
    // operation here — audit pipeline tüm write'ları yakalar
  },
);
```

**`runWithAuditContext()` helper gerekli mi?** Cevap: **opsiyonel ama önerilir** — primitive `als.run` zaten yeterli, ama maintenance ops için defansif wrapper:
```ts
async function runWithMaintenanceAuditContext<T>(
  options: { actor: string; metadata: object },
  fn: () => Promise<T>,
): Promise<T> {
  return als.run(
    {
      userId: options.actor,
      userRoles: ['Admin'],          // implicit, isAdminPrincipal bypass için
      ipAddress: '127.0.0.1',         // local maintenance
      pendingAuditLogs: [],
    },
    fn,
  );
}
```
HTTP context'in farkı: maintenance'da `pendingAuditLogs` queue **kullanılmaz** — non-HTTP fallback (audit.ts:113-115) anında yazar. Yine de queue'yu boş array olarak vermek tip uyumu için zorunlu.

### Prerequisite (b) — Audit log metadata schema 🔴 **EKSİK**

`audit_logs` tablosunda `metadata` JSONB kolonu **yok**. Maintenance ops için ihtiyaç duyulan field'lar (`requestedBy`, `approvedBy`, `operation`, `reason`, `dryRun`) saklanacak yer yok.

**3 alternatif çözüm**:

| # | Yöntem | Avantaj | Dezavantaj |
|---|---|---|---|
| (a) | `before_payload`/`after_payload` JSON içine encode et | Schema değişmez, hızlı | Semantic abuse — payload "değişen veri" olmalı, metadata değil; reader confused; query (`metadata->>'operation'`) yazılamaz |
| (b) | `user` field'ı JSON string olarak kullan (`"maintenance-bot:{...}"`) | Schema değişmez | Hacky, parse-required, mevcut audit_logs query'leri kırılır |
| (c) | **Yeni `audit_logs.metadata` JSONB kolonu (migration)** | Clean, queryable, type-safe | Schema değişikliği — migration + Prisma schema update + `AuditEntry` interface update + `toDbRow` update |
| (d) | Dedicated `maintenance_log` tablosu | Audit_logs'tan ayrı; specific schema | İki kaynak (audit_logs + maintenance_log) — query/reporting karmaşık; double-write riski |

**Default önerim (c)**: `audit_logs.metadata JSONB NULL` migration. Schema-clean, queryable, future-proof. Migration küçük (~5 line). `AuditEntry` interface ve `toDbRow` ekleme ~5 line. Toplam ~10 line + migration file = küçük PR.

⚠️ **Bu, pattern'in prerequisite'i** — maintenance command kurulmadan önce migration uygulanmalı.

### Prerequisite (c) — Worker context phantom write risk ⚠️ **MEVCUT, MAINTENANCE'DA RELEVANT**

audit.ts:112-115 worker context fallback (ALS store yoksa anında yaz) `$transaction` rollback ile uyumsuz olabilir. Mevcut audit raporu Section 6 bunu "false positive — risk var ama somut bug üretmedi" diye sınıflandırmış. Maintenance command'da bu daha relevant olur:
- Maintenance op `prisma.$transaction` içinde yapılırsa: write → audit hook → audit yazıldı; sonra tx rollback olursa **audit kaldı** (phantom write)
- Çözüm: maintenance command'larda explicit transaction wrapper, success-only audit flush. Pattern HTTP onSend flush'a (audit.ts:154-166) benzer ama transaction tier'ında.

**Karar**: maintenance command için **transaction-aware audit pattern**:
- ALS run wrapper içinde `pendingAuditLogs` queue kullan (HTTP gibi)
- Operation success → queue flush
- Operation fail (transaction rollback veya exception) → queue drop, audit yazılmaz
- Bu, mevcut audit plugin'in **non-HTTP davranışını override etmek** demek — nasıl uygulanacağı implementation karar maddesi

---

## 3. Karar Matrisi (kullanıcı input bekleyen)

| # | Karar | Seçenekler | Default önerim |
|---|---|---|---|
| 1 | **`audit_logs.metadata` schema** | (a) payload encode / (b) user JSON / (c) yeni JSONB column / (d) maintenance_log table | **(c)** yeni JSONB column migration — clean, queryable |
| 2 | **Boot mode** | Full app boot / Minimal plugin boot (config + prisma + audit + ALS) | **Minimal** — port bind yok, hızlı startup; full boot fallback verify failure'da |
| 3 | **Entry-point** | (A) one-off command, app-booted / (B) worker background job / (C) admin HTTP endpoint / (D) ayrı CLI paketi | **(A)** — attack surface zero, plugin chain reused, exit on completion |
| 4 | **Actor identity** | maintenance-bot synthetic / human admin Keycloak / hibrit | **maintenance-bot synthetic actor** + metadata.requestedBy human admin email |
| 5 | **Confirmation gating** | Query param (?confirm=true) / Body explicit string / Two-step API (preview → execute) | **Body explicit**: `{ dryRun: false, confirmation: "MAGIC_STRING_PER_OPERATION" }` |
| 6 | **Dual control** | Tek admin yeterli / `requestedBy` + `approvedBy` zorunlu | **Tek admin yeterli** — küçük takım için overhead; `requestedBy=approvedBy` audit'te görünür |
| 7 | **Idempotency** | SHOULD per-op / MUST tüm ops / opsiyonel | **SHOULD** — operation-specific |
| 8 | **Logging** | Console only / audit_logs only / ikisi / dedicated file | **Console + audit_logs** — operasyonel görünürlük + kalıcı kayıt |
| 9 | **Transaction-aware audit** | Mevcut non-HTTP davranış (anında yazım) korunur / queue+success-flush pattern uygulanır | **Queue+success-flush** — phantom write riski kapatılır |
| 10 | **Existing endpoint kullanımı** | Sadece pattern üzerinden / mevcut endpoint'ler "aday yol" | **Aday yol per-op** — örn. `DELETE /schedules/32` zaten audit-traced; restore senaryosunda pattern zorunlu |

---

## 4. Implementation PR Sıralaması

Prerequisite (b) eksik olduğu için pattern **iki PR olarak** gelir:

### PR-1: `audit_logs.metadata` schema migration (prerequisite)
- Prisma migration: `audit_logs.metadata JSONB NULL DEFAULT NULL`
- Prisma schema (`apps/api/prisma/schema.prisma`) `AuditLog.metadata Json?` field eklenir
- `AuditEntry` interface (`audit.ts:6-14`) `metadata?: Record<string, unknown>` eklenir
- `toDbRow` (`audit.ts:131-141`) `metadata` field map'lenir
- Test: HTTP write op'ta `metadata` undefined kalır (backward compat)
- ~10-15 line code + 1 migration file
- Audit raporu Section 1 cross-cutting'e not eklenir

### PR-2: Maintenance command pattern + 3 cleanup operation
- Yeni dizin: `apps/api/src/maintenance/`
- Minimal Fastify boot helper: `apps/api/src/maintenance/boot.ts` (config + prisma + audit plugin chain, route bind yok)
- ALS wrapper: `apps/api/src/maintenance/audit-context.ts` (`runWithMaintenanceAuditContext`)
- Transaction-aware queue+flush helper: maintenance ops için
- 3 cleanup script:
  - `apps/api/src/maintenance/cleanup-schedule-32.ts` (restore mi delete mi user-decided)
  - `apps/api/src/maintenance/cleanup-orphan-plan-items.ts` (54, 107, 108 deleteMany)
  - (MED-001 schema redesign için ayrı PR — pattern'i kullanır)
- Çalıştırma: `docker exec bcms_api node dist/maintenance/cleanup-X.js --dry-run` ve `--confirm=MAGIC`
- Test: dry-run sample preview, confirm flag ile actual write, audit_logs satırı verify (actor=maintenance-bot, metadata={requestedBy, operation, reason})
- Audit raporu Section 4 update: pattern hazır, 3 item closed

### PR-3 (gelecek, ayrı kapsam): MED-001 soft-delete schema redesign
- 21 tabloda `deleted_at` drop migration
- Prisma schema update
- `weekly-shifts/weekly-shift.routes.ts:144` filter kaldırma
- Pattern'i kullanır (PR-2'de kurulan)
- Bu doc'un kapsamı dışında

---

## 5. Test Prosedürü (pattern kanıtı)

Pattern'in audit-traced çalıştığını verify etmek için **canlı test akışı**:

### (1) Pre-test state capture
```bash
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  SELECT count(*) AS pre_count FROM audit_logs;
"
```

### (2) Maintenance op çalıştır (dry-run)
```bash
docker exec bcms_api node dist/maintenance/cleanup-orphan-plan-items.js \
  --dry-run \
  --requested-by="admin@example.com"
```
Beklenen: console'a "would delete 3 rows: [54, 107, 108]" preview, audit_logs **değişmez**.

### (3) Pre-test state re-verify
audit_logs count aynı (preview dry-run).

### (4) Actual run
```bash
docker exec bcms_api node dist/maintenance/cleanup-orphan-plan-items.js \
  --confirm=DELETE_ORPHAN_INGEST_PLAN_ITEMS \
  --requested-by="admin@example.com" \
  --reason="MED-003 cleanup follow-up"
```

### (5) Post-test verify
```bash
docker exec -i bcms_postgres psql -U bcms_user -d bcms -c "
  -- Orphan rows gone
  SELECT count(*) FROM ingest_plan_items WHERE id IN (54, 107, 108);  -- expect 0

  -- Audit log entries written
  SELECT entity_type, entity_id, action, \"user\", metadata
  FROM audit_logs
  WHERE entity_type='IngestPlanItem' AND entity_id IN (54, 107, 108)
  ORDER BY timestamp DESC LIMIT 5;
"
```
Beklenen:
- Orphan count → 0
- 3 audit_log satırı (DELETE action, entity_type='IngestPlanItem')
- `user='maintenance-bot'`
- `metadata={ requestedBy: 'admin@example.com', operation: 'cleanup-orphan-plan-items', reason: 'MED-003...' }`
- `before_payload` orphan satırların pre-delete snapshot'ı

### (6) Pattern kanıtı çıkartılır
Eğer (5) başarılı → pattern audit-traced çalışıyor → `schedules.id=32` ve gelecek MED-001 ops için aynı pattern güvenle kullanılabilir.

⚠️ **Failure modu**: Eğer audit_log satırı yazılmazsa (bypass detected), pattern kullanılmaz; rollback (orphan rows zaten silindi → restore from backup) ve root cause analiz.

---

## 6. Implementation Trigger

PR-1 + PR-2 aşağıdaki kararlar verilir verilmez gelir:

1. ✅ Prerequisite (a) ALS push API hazır (verify edildi)
2. 🔴 Prerequisite (b) metadata schema seçimi (default: (c) JSONB migration)
3. 🔴 Karar matrisi #2-#9 (default'lar onaylandı mı, değişiklik var mı)
4. 🔴 schedules.id=32 final karar: restore (canonical-make) mi hard delete mi
5. 🔴 Cleanup operation magic string'leri (örn. `DELETE_ORPHAN_INGEST_PLAN_ITEMS`)

Yukarıdaki kararlar verilince **PR-1** açılır (schema migration), kabul edilince **PR-2** (maintenance command + 3 cleanup script) gelir.

---

## 7. Audit & Risk Etkisi (mevcut durum vs hedef)

| Senaryo | Şimdiki durum | Pattern kurulduktan sonra |
|---|---|---|
| schedules.id=32 cleanup | 🔴 raw SQL veya naive script riski; deferred | ✅ pattern üzerinden audit-traced uygulanır |
| 3 orphan ingest_plan_items | 🔴 aynı blokaj | ✅ aynı çözüm |
| MED-001 schema redesign post-data fixup | 🔴 büyük schema migration + write riski | ✅ pattern PR-3 için altyapı |
| Gelecek ad-hoc maintenance | 🔴 her seferinde "raw SQL kullanmamalıyım" disipline ihtiyaç | ✅ canonical entry-point — yanlış path kapanır |
| Audit trail visibility | 🟡 audit_logs'ta data var ama kim/neden/operation eksik | ✅ metadata field ile full context |

**MED-001 unblock'u + cleanup item'ları kapatma** = pattern kurulması = **3 açık risk birden azalır**.

---

## 8. Out of Scope (bu doc dışı)

- PR-1 / PR-2 fiili implementation (kod yazılmadı, migration uygulanmadı)
- 3 cleanup operation'ın çalıştırılması (her biri için kullanıcı kararı + magic string + reason gerekir)
- MED-001 schema redesign (ayrı PR-3, pattern'i tüketir)
- Permission model değişikliği (rbac.ts dokunulmaz; maintenance-bot synthetic actor sadece audit_logs kayıt amaçlı, permission gating'e girmez)
- HTTP endpoint olarak maintenance ops (entry-point default A; HTTP sadece recurring/self-service için ileride)
- Healthcheck design (ayrı follow-up; bu pattern'le bağımsız)
