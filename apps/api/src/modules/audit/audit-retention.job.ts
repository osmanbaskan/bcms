import type { FastifyInstance } from 'fastify';

const BATCH_SIZE = 10_000;
const DEFAULT_RETENTION_DAYS = 90;

function msUntilNextMidnight(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 5, 0, 0);
  return next.getTime() - now.getTime();
}

function getRetentionDays(): number {
  const raw = process.env.AUDIT_RETENTION_DAYS;
  if (!raw) return DEFAULT_RETENTION_DAYS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

export async function startAuditRetentionJob(app: FastifyInstance): Promise<void> {
  const retentionDays = getRetentionDays();
  app.log.info({ retentionDays }, 'Audit retention job configured');

  const runOnce = async (): Promise<void> => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    cutoff.setHours(0, 0, 0, 0);

    let totalDeleted = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const batch = await app.prisma.auditLog.findMany({
          where: {
            timestamp: { lt: cutoff },
          },
          take: BATCH_SIZE,
          select: { id: true },
          orderBy: { timestamp: 'asc' },
        });

        if (batch.length === 0) break;

        const result = await app.prisma.auditLog.deleteMany({
          where: {
            id: { in: batch.map((b) => b.id) },
          },
        });

        totalDeleted += result.count;

        if (batch.length < BATCH_SIZE) break;
      } catch (err) {
        app.log.error({ err, cutoff: cutoff.toISOString() }, 'Audit retention purge failed');
        break;
      }
    }

    if (totalDeleted > 0) {
      app.log.info({ totalDeleted, retentionDays }, 'Audit retention purge complete');
    }
  };

  // Initial run shortly after startup (staggered to avoid competing with other init work).
  // LOW-API-017 fix (2026-05-05): .unref() ile bu timer event loop'u
  // bloklamaz; SIGTERM sonrası process tertemiz çıkar. onClose hook ile de
  // temizleniyor (defansif).
  const initialDelay = Math.min(msUntilNextMidnight() + 30_000, 60_000);
  const startupTimer = setTimeout(() => {
    runOnce().catch((err) => app.log.error({ err }, 'Audit retention initial run failed'));
  }, initialDelay);
  startupTimer.unref();

  const intervalTimer = setInterval(() => {
    runOnce().catch((err) => app.log.error({ err }, 'Audit retention scheduled run failed'));
  }, 86_400_000);
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    clearTimeout(startupTimer);
    clearInterval(intervalTimer);
  });
}
