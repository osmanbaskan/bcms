import type { FastifyInstance } from 'fastify';
import { dropPartition, findExpiredPartitions, isTablePartitioned } from './audit-retention.helpers.js';

const BATCH_SIZE = 10_000;
const DEFAULT_RETENTION_DAYS = 90;
const TR_TIMEZONE = 'Europe/Istanbul';

function isDryRun(): boolean {
  return process.env.AUDIT_RETENTION_DRY_RUN === 'true';
}

// ORTA-API-1.10.6 fix (2026-05-04): retention job'unun "günün sonu"
// hesaplamaları Istanbul saatine göre yapılmalı (yayıncılık standardı).
// Önceden new Date(...) local TZ kullanıyordu; container UTC ise gerçek
// Türkiye gece yarısı yerine 03:05 IST'te tetikleniyordu.
function istanbulNow(): Date {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TR_TIMEZONE }));
}

function msUntilNextMidnightIstanbul(): number {
  const ist = istanbulNow();
  const next = new Date(ist.getFullYear(), ist.getMonth(), ist.getDate() + 1, 0, 5, 0, 0);
  // ist <-> wall-clock farkı zaten hesaba katılmış; runtime'da direkt diff.
  return Math.max(60_000, next.getTime() - ist.getTime());
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
    // ORTA-API-1.10.7 fix (2026-05-04): cutoff Istanbul gün başına hizalı.
    const ist = istanbulNow();
    ist.setDate(ist.getDate() - retentionDays);
    ist.setHours(0, 0, 0, 0);
    const cutoff = ist;
    const dryRun = isDryRun();

    // Madde 1 PR-1B (audit doc): feature-detect partitioned vs regular.
    // Partitioned ise DROP TABLE expired partitions (instant, zero row lock).
    // Regular ise mevcut deleteMany fallback (regression korunur — chunking yok,
    // scope creep önlenir).
    let partitioned = false;
    try {
      partitioned = await isTablePartitioned(app.prisma);
    } catch (err) {
      app.log.warn({ err }, 'isTablePartitioned check başarısız; fallback deleteMany path');
    }

    if (partitioned) {
      await runOncePartitioned(cutoff, dryRun);
      return;
    }
    await runOnceFallback(cutoff, dryRun);
  };

  const runOncePartitioned = async (cutoff: Date, dryRun: boolean): Promise<void> => {
    let dropped = 0;
    try {
      const expired = await findExpiredPartitions(app.prisma, cutoff);
      for (const p of expired) {
        try {
          await dropPartition(app.prisma, p.name, { dryRun });
          dropped += 1;
          app.log.info({ strategy: 'drop_partition', partition: p.name, dryRun }, 'Audit partition processed');
        } catch (err) {
          app.log.error({ err, partition: p.name }, 'Audit partition drop başarısız');
        }
      }
      app.log.info(
        { strategy: 'drop_partition', cutoff: cutoff.toISOString(), retentionDays, dropped, dryRun },
        'Audit retention complete (partitioned path)',
      );
    } catch (err) {
      app.log.error({ err, cutoff: cutoff.toISOString() }, 'Audit retention partitioned path failed');
    }
  };

  const runOnceFallback = async (cutoff: Date, dryRun: boolean): Promise<void> => {
    let totalDeleted = 0;
    let consecutiveErrors = 0;

    if (dryRun) {
      try {
        const wouldDelete = await app.prisma.auditLog.count({ where: { timestamp: { lt: cutoff } } });
        app.log.info(
          { strategy: 'delete_many', cutoff: cutoff.toISOString(), retentionDays, wouldDelete, dryRun },
          'Audit retention dry-run (fallback path)',
        );
      } catch (err) {
        app.log.error({ err }, 'Audit retention dry-run count başarısız');
      }
      return;
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        // ORTA-API-1.10.8 fix (2026-05-04): two-phase delete kaldırıldı.
        // Önceden findMany({id}) + deleteMany({id in [...]}) iki sorgu yapıyordu;
        // tek sorguda timestamp range delete yeterli. take limit yok ama
        // chunked LIMIT için DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT N)
        // hile gerekiyor — Prisma desteklemiyor. Basit yaklaşım: timestamp
        // bucket küçültücü explicit LIMIT'siz delete. Postgres VACUUM
        // sonrası reuse OK; lock window kabul edilebilir (gece çalışıyor).
        const result = await app.prisma.auditLog.deleteMany({
          where: { timestamp: { lt: cutoff } },
        });
        totalDeleted += result.count;
        consecutiveErrors = 0;
        // Tek delete tüm satırları siliyor; loop tek iterasyonda biter.
        break;
      } catch (err) {
        consecutiveErrors += 1;
        app.log.error({ err, cutoff: cutoff.toISOString(), consecutiveErrors }, 'Audit retention purge failed');
        // ORTA-API-1.10.9 fix (2026-05-04): hata durumunda tek silent break
        // yerine 3 deneme + exponential backoff (10s, 20s, 40s).
        if (consecutiveErrors >= 3) break;
        await new Promise((r) => setTimeout(r, 10_000 * consecutiveErrors));
      }
    }

    if (totalDeleted > 0) {
      app.log.info(
        { strategy: 'delete_many', cutoff: cutoff.toISOString(), retentionDays, totalDeleted },
        'Audit retention complete (fallback path)',
      );
    }
  };

  // Initial run shortly after startup (staggered to avoid competing with other init work).
  // LOW-API-017 fix (2026-05-05): .unref() ile bu timer event loop'u
  // bloklamaz; SIGTERM sonrası process tertemiz çıkar. onClose hook ile de
  // temizleniyor (defansif).
  // DÜŞÜK-API-1.10.10 fix (2026-05-04): isim ve davranış uyumlu — cap 60s,
  // boot+1dk içinde ilk purge çalışır; gerçek "midnight" timing daha sonra
  // 24h interval ile yakalanır.
  const initialDelay = Math.min(msUntilNextMidnightIstanbul() + 30_000, 60_000);
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
