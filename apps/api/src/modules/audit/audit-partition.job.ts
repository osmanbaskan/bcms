import type { FastifyInstance } from 'fastify';
import { isTablePartitioned } from './audit-retention.helpers.js';
import {
  ensureMonthlyPartition,
  monthsAhead,
} from './audit-partition.helpers.js';

/**
 * Madde 1 PR-1C (audit doc): partition pre-create background service.
 *
 * - Boot'ta bir kez runOnce; sonra setInterval(24h).
 * - isTablePartitioned skip: production'da partitioned tabloda çalışır;
 *   dev/test DB'de regular tabloda no-op + warn (helper SQL fail'i önlenir).
 * - Window: monthsAhead(now, 4) — current + 3 ileri ay.
 * - Idempotent: CREATE TABLE IF NOT EXISTS.
 * - Dry-run: AUDIT_PARTITION_DRY_RUN=true (öncelik); backward-compat
 *   AUDIT_RETENTION_DRY_RUN=true ikincil kabul.
 *
 * Bkz: ops/REQUIREMENTS-AUDITLOG-PARTITION-V1.md
 *      ops/RUNBOOK-AUDITLOG-PARTITION-DEPLOY.md §6
 */

const AHEAD_MONTH_COUNT = 4; // current + 3 ileri ay
const RUN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 saat
const PARENT_TABLE = 'audit_logs';

function isDryRun(): boolean {
  return (
    process.env.AUDIT_PARTITION_DRY_RUN === 'true'
    || process.env.AUDIT_RETENTION_DRY_RUN === 'true'  // backward-compat
  );
}

export async function startAuditPartitionJob(app: FastifyInstance): Promise<void> {
  app.log.info({ aheadMonths: AHEAD_MONTH_COUNT, parent: PARENT_TABLE }, 'Audit partition pre-create job configured');

  const runOnce = async (): Promise<void> => {
    const dryRun = isDryRun();
    let partitioned = false;
    try {
      partitioned = await isTablePartitioned(app.prisma, PARENT_TABLE);
    } catch (err) {
      app.log.warn({ err, parent: PARENT_TABLE }, 'isTablePartitioned check failed; partition pre-create skip');
      return;
    }

    if (!partitioned) {
      app.log.info({ parent: PARENT_TABLE }, 'audit_logs partitioned değil (regular table); pre-create skip');
      return;
    }

    const now = new Date();
    const targets = monthsAhead(now, AHEAD_MONTH_COUNT);
    const created: string[] = [];
    const existed: string[] = [];
    const dryRunNoOp: string[] = [];
    const failed: { name: string; err: unknown }[] = [];

    for (const { year, month } of targets) {
      try {
        const result = await ensureMonthlyPartition(app.prisma, PARENT_TABLE, year, month, { dryRun });
        if (result.action === 'created') created.push(result.name);
        else if (result.action === 'existed') existed.push(result.name);
        else dryRunNoOp.push(result.name);
      } catch (err) {
        failed.push({ name: `${PARENT_TABLE}_${year}_${String(month).padStart(2, '0')}`, err });
        app.log.error({ err, year, month }, 'Audit partition ensure failed');
      }
    }

    app.log.info(
      { strategy: 'pre_create', dryRun, created, existed, dryRunNoOp, failed: failed.map((f) => f.name) },
      'Audit partition pre-create complete',
    );
  };

  // Initial run staggered after boot (5s delay; diğer servislerle çakışmasın).
  const initialTimer = setTimeout(() => {
    runOnce().catch((err) => app.log.error({ err }, 'Audit partition initial run failed'));
  }, 5_000);
  initialTimer.unref();

  const intervalTimer = setInterval(() => {
    runOnce().catch((err) => app.log.error({ err }, 'Audit partition scheduled run failed'));
  }, RUN_INTERVAL_MS);
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    clearTimeout(initialTimer);
    clearInterval(intervalTimer);
  });
}
