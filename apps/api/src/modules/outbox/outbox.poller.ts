import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { resolveOutboxQueue } from './outbox.routing.js';

/**
 * Madde 2+7 PR-C1 (audit doc): Outbox poller — Phase 3 prereq bring-up.
 *
 * Tasarım: ops/REQUIREMENTS-OUTBOX-POLLER-CUTOVER-V1.md
 *
 * PR-C1 invariant:
 * - Poller running (OUTBOX_POLLER_ENABLED=true), but Phase 2 shadow yazımları
 *   hâlâ status='published' ile geliyor → poller WHERE status='pending' bulamaz
 *   ve idle kalır. Bu PR'ın amacı: poller iskeleti + state machine + smoke
 *   verify. Cut-over (shadow→pending + direct publish disable) PR-C2.
 *
 * Lifecycle: BCMS_BACKGROUND_SERVICES='outbox-poller' worker container'ında
 * çalışır. Single-worker varsayımı (ops doc §10 karar 4); multi-worker
 * gerekirse SKIP LOCKED davranışı zaten future-proof + jitter V2.
 *
 * State machine (ops doc §2):
 *   pending → published (success)
 *   pending → failed   (transient error, attempts < MAX) → backoff retry
 *   pending → dead     (attempts >= MAX) → manuel replay (PR-D admin endpoint)
 *
 * Locked decisions (PR-A REQUIREMENTS-OUTBOX-DLQ-V1.md §6):
 *   POLL_INTERVAL_MS = 2_000
 *   BATCH_SIZE       = 100
 *   MAX_ATTEMPTS     = 5
 *   BACKOFF_BASE_MS  = 5_000  → 5s,10s,20s,40s,80s; cap 30 dk
 */

const POLL_INTERVAL_MS = 2_000;
const BATCH_SIZE = 100;
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const TX_TIMEOUT_MS = 60_000;

export interface OutboxRow {
  id:             number;
  event_id:       string;
  event_type:     string;
  aggregate_type: string;
  aggregate_id:   string;
  schema_version: number;
  payload:        Prisma.JsonValue;
  status:         string;
  attempts:       number;
  last_error:     string | null;
  occurred_at:    Date;
  created_at:     Date;
  published_at:   Date | null;
  next_attempt_at: Date;
  idempotency_key: string | null;
}

export interface PollOnceResult {
  picked:    number;
  published: number;
  failed:    number;
  dead:      number;
  skipped:   number; // dry-run veya pre-flight skip
}

function isEnabled(): boolean {
  return (process.env.OUTBOX_POLLER_ENABLED ?? '').toLowerCase() === 'true';
}

function isDryRun(): boolean {
  return (process.env.OUTBOX_POLLER_DRY_RUN ?? '').toLowerCase() === 'true';
}

function nextBackoffMs(currentAttempts: number): number {
  // 0→5s, 1→10s, 2→20s, 3→40s, 4→80s; cap 30dk.
  const exp = BACKOFF_BASE_MS * 2 ** currentAttempts;
  return Math.min(exp, BACKOFF_CAP_MS);
}

/**
 * Tek poll iterasyonu. Test edilebilir; export edilir.
 *
 * Akış:
 *   1. SELECT pending events FOR UPDATE SKIP LOCKED LIMIT BATCH_SIZE
 *      (interactive tx; lock commit'te bırakılır).
 *   2. Her event için: queue resolve + publish + status update.
 *   3. Publish hatası → failed/dead + backoff schedule.
 *
 * NOT — single-worker varsayımı: SELECT tx commit ile lock bırakılır; ikinci
 * worker aynı row'u pick edebilir (race penceresi). PR-A locked V1 default
 * tek worker container; multi-worker future scope (jitter + lease pattern).
 */
export async function pollOnce(app: FastifyInstance): Promise<PollOnceResult> {
  const result: PollOnceResult = { picked: 0, published: 0, failed: 0, dead: 0, skipped: 0 };

  const events = await app.prisma.$transaction(
    async (tx) => tx.$queryRaw<OutboxRow[]>`
      SELECT *
      FROM "outbox_events"
      WHERE "status" = 'pending' AND "next_attempt_at" <= NOW()
      ORDER BY "next_attempt_at" ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `,
    { timeout: TX_TIMEOUT_MS },
  );

  result.picked = events.length;
  if (events.length === 0) return result;

  const dry = isDryRun();

  for (const event of events) {
    if (dry) {
      app.log.info(
        { eventId: event.event_id, eventType: event.event_type, dryRun: true },
        'Outbox poller dry-run — publish skip',
      );
      result.skipped += 1;
      continue;
    }

    try {
      const queue = resolveOutboxQueue(event.event_type);
      await app.rabbitmq.publish(queue, event.payload);
      await app.prisma.outboxEvent.update({
        where: { id: event.id },
        data:  { status: 'published', publishedAt: new Date() },
      });
      result.published += 1;
    } catch (err) {
      const errorMsg = String((err as Error)?.message ?? err);
      const nextAttempts = event.attempts + 1;
      const isDead = nextAttempts >= MAX_ATTEMPTS;
      const backoff = nextBackoffMs(event.attempts);

      app.log.error(
        {
          eventId: event.event_id,
          eventType: event.event_type,
          attempts: nextAttempts,
          isDead,
          err,
        },
        'Outbox poller publish failed',
      );

      await app.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status:        isDead ? 'dead' : 'failed',
          attempts:      nextAttempts,
          lastError:     errorMsg.slice(0, 1000),
          nextAttemptAt: new Date(Date.now() + backoff),
        },
      });

      // failed/dead row'u poller WHERE status='pending' filter'ı yüzünden bir
      // sonraki turlarda pick etmez. failed → pending revert'i poller değil
      // backoff schedule (next_attempt_at geçince ayrı state transition: bu
      // V1'de yok; failed pending'e otomatik dönmez. PR-D admin replay veya
      // schedule worker pattern V2 scope.)
      // NOT: PR-A doc'unda "failed → pending (next_attempt_at geçince)"
      // yazıyor; o davranış V2'ye taşınır — V1'de failed satır admin replay
      // bekler. Bu davranış farkı PR-D requirements'ta netleşecek.

      if (isDead) result.dead += 1;
      else        result.failed += 1;
    }
  }

  return result;
}

/**
 * Background service entry point. BCMS_BACKGROUND_SERVICES='outbox-poller'
 * ile worker container'ında start edilir. OUTBOX_POLLER_ENABLED=true yoksa
 * iskelet koşar ama interval başlatılmaz (no-op).
 */
export async function startOutboxPoller(app: FastifyInstance): Promise<void> {
  if (!isEnabled()) {
    app.log.info({ enabled: false }, 'Outbox poller disabled (OUTBOX_POLLER_ENABLED!=true)');
    return;
  }

  app.log.info(
    { intervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE, dryRun: isDryRun() },
    'Outbox poller starting',
  );

  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // overlap guard — uzun bir tick sonraki interval'i ezmesin
    running = true;
    try {
      const r = await pollOnce(app);
      if (r.picked > 0) {
        app.log.info(
          { picked: r.picked, published: r.published, failed: r.failed, dead: r.dead, skipped: r.skipped },
          'Outbox poller tick',
        );
      }
    } catch (err) {
      app.log.error({ err }, 'Outbox poller tick crashed');
    } finally {
      running = false;
    }
  };

  const intervalTimer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  intervalTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(intervalTimer);
    app.log.info('Outbox poller stopped');
  });
}
