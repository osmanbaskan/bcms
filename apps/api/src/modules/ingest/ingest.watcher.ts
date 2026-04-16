import path from 'path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { QUEUES } from '../../plugins/rabbitmq.js';

const WATCH_FOLDER    = process.env.WATCH_FOLDER ?? './tmp/watch';
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mxf', '.avi', '.ts', '.mts', '.m2ts', '.mkv', '.wmv']);

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
      const job = await app.prisma.ingestJob.create({
        data: { sourcePath: filePath },
      });

      await app.rabbitmq.publish(QUEUES.INGEST_NEW, {
        jobId:      job.id,
        sourcePath: filePath,
      });

      app.log.info({ jobId: job.id, filePath }, 'Ingest job kuyruğa eklendi');
    } catch (err) {
      app.log.error({ err, filePath }, 'Watch folder: job oluşturulamadı');
    }
  });

  watcher.on('error', (err: unknown) => {
    app.log.error({ err }, 'Watch folder izleyici hatası');
  });

  app.log.info({ folder: WATCH_FOLDER }, 'Watch folder izleniyor');
}
