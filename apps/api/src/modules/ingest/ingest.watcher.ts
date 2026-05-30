import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { isOutboxPollerAuthoritative, writeShadowEvent } from '../outbox/outbox.helpers.js';
import { validateIngestSourcePath, VIDEO_EXTENSIONS } from './ingest.paths.js';
import { startHeartbeatTicker } from '../../lib/service-heartbeat.js';
import { parseBoolEnv } from '../provys/provys.watcher.js';

const WATCH_FOLDER    = process.env.WATCH_FOLDER ?? './tmp/watch';
// Audit #2b (2026-05-30): default false (mevcut davranis); ops true yapip
// restart re-import'u kapatabilir.
const IGNORE_INITIAL  = parseBoolEnv(process.env.INGEST_WATCHER_IGNORE_INITIAL, false);

export function startIngestWatcher(app: FastifyInstance): void {
  startHeartbeatTicker('ingest-watcher', app);
  const watcher = chokidar.watch(WATCH_FOLDER, {
    persistent:     true,
    ignoreInitial:  IGNORE_INITIAL,   // INGEST_WATCHER_IGNORE_INITIAL=true ile kapatilabilir
    awaitWriteFinish: {
      stabilityThreshold: 3000, // wait 3 s with no size change before firing
      pollInterval:        500,
    },
  });

  watcher.on('add', async (filePath: string) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!VIDEO_EXTENSIONS.has(ext)) return;

    app.log.info({ filePath }, 'Watch folder: yeni dosya algılandı');

    try {
      const sourcePath = validateIngestSourcePath(filePath);

      // Audit #2b (2026-05-30): dosya ingest sonrasi klasorde kalir (worker
      // tasimaz); ignoreInitial:false her restart'ta ayni sourcePath'e MUKERRER
      // job yaratirdi. Inbox semantigi: ayni path icin job varsa atla.
      const existing = await app.prisma.ingestJob.findFirst({
        where: { sourcePath },
        select: { id: true, status: true },
      });
      if (existing) {
        app.log.info(
          { filePath, existingJobId: existing.id, status: existing.status },
          'Ingest: bu sourcePath icin job zaten var, atlandi (restart dedup)',
        );
        return;
      }

      // Madde 2+7 PR-B3b-1: tx içinde job create + shadow outbox; direct
      // publish (queue.ingest.new) tx dışında — mevcut davranış korunur.
      // Shadow row eventType='ingest.job_started', payload mevcut publish ile 1:1.
      const job = await app.prisma.$transaction(async (tx) => {
        const created = await tx.ingestJob.create({ data: { sourcePath } });
        await writeShadowEvent(tx, {
          eventType:     'ingest.job_started',
          aggregateType: 'IngestJob',
          aggregateId:   created.id,
          payload: {
            jobId:      created.id,
            sourcePath: created.sourcePath,
          },
        });
        return created;
      });

      if (!isOutboxPollerAuthoritative()) {
        await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
          jobId:      job.id,
          sourcePath,
        });
      } else {
        app.log.debug(
          { domain: 'ingest', queue: QUEUES.INGEST_NEW, eventType: 'ingest.job_started' },
          'direct publish skipped — outbox poller authoritative',
        );
      }

      app.log.info({ jobId: job.id, sourcePath }, 'Ingest job kuyruğa eklendi');
    } catch (err) {
      app.log.error({ err, filePath }, 'Watch folder: job oluşturulamadı');
    }
  });

  watcher.on('error', (err: unknown) => {
    app.log.error({ err }, 'Watch folder izleyici hatası');
  });

  // HIGH-API-018 fix (2026-05-05): graceful close on Fastify shutdown.
  // Aksi halde watcher'ın FS handle'ları process exit'e takılır; testlerde
  // process hang olur, prod'da SIGTERM sırasında 60s grace period boyunca
  // cleanup yapamaz.
  app.addHook('onClose', async () => {
    try {
      await watcher.close();
      app.log.info('Ingest watch folder kapandı');
    } catch (err) {
      app.log.warn({ err }, 'Ingest watcher close hatası');
    }
  });

  app.log.info({ folder: WATCH_FOLDER }, 'Watch folder izleniyor');
}
