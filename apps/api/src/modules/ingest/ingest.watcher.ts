import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { QUEUES } from '../../plugins/rabbitmq.js';
import { validateIngestSourcePath, VIDEO_EXTENSIONS } from './ingest.paths.js';

const WATCH_FOLDER    = process.env.WATCH_FOLDER ?? './tmp/watch';

export function startIngestWatcher(app: FastifyInstance): void {
  const watcher = chokidar.watch(WATCH_FOLDER, {
    persistent:     true,
    ignoreInitial:  false,   // process files already present on startup
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

      const job = await app.prisma.ingestJob.create({
        data: { sourcePath },
      });

      await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
        jobId:      job.id,
        sourcePath,
      });

      app.log.info({ jobId: job.id, sourcePath }, 'Ingest job kuyruğa eklendi');
    } catch (err) {
      app.log.error({ err, filePath }, 'Watch folder: job oluşturulamadı');
    }
  });

  watcher.on('error', (err: unknown) => {
    app.log.error({ err }, 'Watch folder izleyici hatası');
  });

  app.log.info({ folder: WATCH_FOLDER }, 'Watch folder izleniyor');
}
