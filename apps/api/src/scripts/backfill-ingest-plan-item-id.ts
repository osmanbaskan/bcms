/**
 * Phase A2 PR-2b — IngestJob.planItemId backfill (DECISION-BACKEND-CANONICAL-DATA-MODEL-V1 §4.A2 / §10/4).
 *
 * Hedef: A2 PR-2a deploy edildikten sonra, eski (legacy) `ingest_jobs` satırları
 * için `planItemId IS NULL AND metadata->>'ingestPlanSourceKey' IS NOT NULL`
 * koşulunu sağlayan kayıtları, eşleşen `ingest_plan_items.source_key` üzerinden
 * canonical FK'ye doldurur. Eşleşme bulunmayan kayıtlar (orphan) raporlanır,
 * güncellenmez. Idempotent: ikinci çalıştırma no-op.
 *
 * Kural uyumu (CLAUDE.md):
 *   - Tüm UPDATE'ler Prisma `$extends` audit plugin üzerinden gider
 *     (createAuditedPrisma factory). Worker/background bağlamında audit entries
 *     anında `audit_logs` tablosuna yazılır.
 *   - Raw SQL UPDATE/INSERT/DELETE YOK.
 *   - Büyük tek transaction YOK; batch bazlı ilerler (default 100).
 *   - Default DRY-RUN; gerçek yazma sadece `--execute` flag ile.
 *
 * Bu PR'da production'da çalıştırılmaz; PR-2c (fallback removal) öncesi ayrı
 * runbook gate'inde manuel olarak çalıştırılır. Bkz:
 * `ops/runbooks/A2-PR2B-INGEST-PLAN-ITEM-BACKFILL.md`.
 */
import type { PrismaClient } from '@prisma/client';
import { createAuditedPrisma, type AuditedPrismaHandle } from './prisma-factory.js';

export interface BackfillOptions {
  dryRun:    boolean;
  batchSize: number;
  /** Üretilecek örnek satır limiti (rapor için). */
  sampleLimit?: number;
}

export interface BackfillSamples {
  matchSamples:  Array<{ jobId: number; sourceKey: string; planItemId: number }>;
  orphanSamples: Array<{ jobId: number; sourceKey: string }>;
}

export interface BackfillResult extends BackfillSamples {
  scanned:       number;
  alreadyLinked: number;
  noKey:         number;
  matchable:     number;
  orphan:        number;
  updated:       number;
  dryRun:        boolean;
  batchSize:     number;
}

const DEFAULT_BATCH_SIZE  = 100;
const DEFAULT_SAMPLE_LIMIT = 10;

/**
 * Pure core: client (audit-extended) + opts → result. Test edilebilir.
 *
 * Akış:
 *   1. Cursor-based scan: `planItemId IS NULL` olan tüm kayıtları id artan sırayla,
 *      batch'ler halinde tara. (Production volume bilinmiyor; tek findMany ile tüm
 *      tabloyu belleğe almak yasak.)
 *   2. Her satır için JS-side classification:
 *      - metadata yok ya da `ingestPlanSourceKey` string değil → `noKey++`
 *      - sourceKey planItem'a eşleniyorsa → `matchable++`, execute modda update.
 *      - sourceKey var ama planItem yok → `orphan++` (rapor; update yok).
 *   3. Update ÷ batch-bazlı tek tek `prisma.ingestJob.update({ where: { id }, data })`.
 *      Idempotency: where klozunda `planItemId: null` filter (race-safe; başkası
 *      bu arada doldurmuşsa update no-op olur, no error).
 */
export async function runBackfill(
  client: PrismaClient,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  if (!Number.isFinite(opts.batchSize) || opts.batchSize <= 0) {
    throw new Error(`backfill: batchSize geçersiz: ${opts.batchSize}`);
  }

  const sampleLimit = opts.sampleLimit ?? DEFAULT_SAMPLE_LIMIT;
  const result: BackfillResult = {
    scanned:       0,
    alreadyLinked: 0,
    noKey:         0,
    matchable:     0,
    orphan:        0,
    updated:       0,
    matchSamples:  [],
    orphanSamples: [],
    dryRun:        opts.dryRun,
    batchSize:     opts.batchSize,
  };

  let lastId: number | null = null;
  for (;;) {
    const batch: Array<{ id: number; metadata: unknown }> = lastId !== null
      ? await client.ingestJob.findMany({
          where:   { planItemId: null },
          orderBy: { id: 'asc' },
          take:    opts.batchSize,
          cursor:  { id: lastId },
          skip:    1,
          select:  { id: true, metadata: true },
        })
      : await client.ingestJob.findMany({
          where:   { planItemId: null },
          orderBy: { id: 'asc' },
          take:    opts.batchSize,
          select:  { id: true, metadata: true },
        });
    if (batch.length === 0) break;

    for (const row of batch) {
      result.scanned++;
      const meta = row.metadata as Record<string, unknown> | null;
      const sourceKey = meta && typeof meta.ingestPlanSourceKey === 'string'
        ? meta.ingestPlanSourceKey
        : null;
      if (!sourceKey) {
        result.noKey++;
        continue;
      }

      const planItem = await client.ingestPlanItem.findUnique({
        where:  { sourceKey },
        select: { id: true },
      });

      if (!planItem) {
        result.orphan++;
        if (result.orphanSamples.length < sampleLimit) {
          result.orphanSamples.push({ jobId: row.id, sourceKey });
        }
        continue;
      }

      result.matchable++;
      if (result.matchSamples.length < sampleLimit) {
        result.matchSamples.push({ jobId: row.id, sourceKey, planItemId: planItem.id });
      }

      if (!opts.dryRun) {
        // Idempotent guard: where içinde planItemId:null koşulu — paralel
        // çalıştırma / parça run senaryosunda aynı satıra ikinci yazımı engeller.
        // Update Prisma client üzerinden → audit extension'ın worker branch'i
        // audit_logs'a anında bir CREATE satırı yazar.
        const updateRes = await client.ingestJob.updateMany({
          where: { id: row.id, planItemId: null },
          data:  { planItemId: planItem.id },
        });
        if (updateRes.count === 1) {
          result.updated++;
        }
      }
    }

    lastId = batch[batch.length - 1].id;
  }

  // alreadyLinked: planItemId NULL OLMAYAN kayıtların sayısı (raporlama için
  // yararlı; scanned'a dâhil değil — scan filter'ı `planItemId: null`).
  result.alreadyLinked = await client.ingestJob.count({
    where: { planItemId: { not: null } },
  });

  return result;
}

interface CliArgs {
  execute:   boolean;
  batchSize: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, batchSize: DEFAULT_BATCH_SIZE };
  for (const a of argv.slice(2)) {
    if (a === '--execute') {
      args.execute = true;
    } else if (a.startsWith('--batch-size=')) {
      const v = Number.parseInt(a.split('=')[1], 10);
      if (!Number.isFinite(v) || v <= 0) {
        throw new Error(`Geçersiz --batch-size: ${a}`);
      }
      args.batchSize = v;
    } else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Bilinmeyen argüman: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`backfill-ingest-plan-item-id

Kullanım (dev/local — tsx + src/ + apps/api/package.json mevcut):
  npm run backfill:ingest-plan-item-id -- [--execute] [--batch-size=N]

Kullanım (production — sadece /app/dist + /app/node_modules; tsx + src + package.json YOK):
  docker exec -i bcms_api node dist/scripts/backfill-ingest-plan-item-id.js [--execute] [--batch-size=N]

Default:
  --batch-size=${DEFAULT_BATCH_SIZE}
  DRY-RUN (yazma yok)

Flags:
  --execute      Gerçek UPDATE'leri çalıştır (audit extension üzerinden).
  --batch-size=N Cursor batch büyüklüğü (default ${DEFAULT_BATCH_SIZE}).
  --help, -h     Bu mesajı göster.`);
}

function printReport(result: BackfillResult): void {
  // eslint-disable-next-line no-console
  const log = (...a: unknown[]) => console.log(...a);
  log('===== BACKFILL RAPORU =====');
  log(`mod                : ${result.dryRun ? 'DRY-RUN' : 'EXECUTE'}`);
  log(`batch size         : ${result.batchSize}`);
  log(`taranan (NULL FK)  : ${result.scanned}`);
  log(`zaten dolu (FK)    : ${result.alreadyLinked}`);
  log(`metadata key yok   : ${result.noKey}`);
  log(`eşleşen (matchable): ${result.matchable}`);
  log(`orphan (no planItem): ${result.orphan}`);
  log(`update edilen      : ${result.updated}`);
  if (result.matchSamples.length > 0) {
    log('--- match örnekleri (ilk N) ---');
    for (const s of result.matchSamples) {
      log(`  jobId=${s.jobId} sourceKey=${s.sourceKey} → planItemId=${s.planItemId}`);
    }
  }
  if (result.orphanSamples.length > 0) {
    log('--- orphan örnekleri (ilk N) ---');
    for (const s of result.orphanSamples) {
      log(`  jobId=${s.jobId} sourceKey=${s.sourceKey} (planItem bulunamadı)`);
    }
  }
  if (result.dryRun) {
    log('---');
    log('DRY-RUN: hiçbir kayıt güncellenmedi. Gerçek backfill için --execute ekleyin.');
  }
}

async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error((e as Error).message);
    printHelp();
    process.exit(2);
  }

  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.error('DATABASE_URL set edilmemiş.');
    process.exit(2);
  }

  let handle: AuditedPrismaHandle | null = null;
  try {
    handle = createAuditedPrisma();
    const result = await runBackfill(handle.client as unknown as PrismaClient, {
      dryRun:    !args.execute,
      batchSize: args.batchSize,
    });
    printReport(result);
    process.exit(0);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('Backfill hatası:', e);
    process.exit(1);
  } finally {
    if (handle) await handle.base.$disconnect().catch(() => { /* ignore */ });
  }
}

// CLI entry — yalnız doğrudan çalıştırıldığında.
const invokedAsScript = (() => {
  try {
    const entry = process.argv[1] ?? '';
    return entry.endsWith('backfill-ingest-plan-item-id.ts')
      || entry.endsWith('backfill-ingest-plan-item-id.js');
  } catch { return false; }
})();
if (invokedAsScript) {
  void main();
}
