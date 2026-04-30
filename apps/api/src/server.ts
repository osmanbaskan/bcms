import { buildApp } from './app.js';

// Worker bağlamında devam eden ingest/bxf işlemleri 30 sn'den uzun sürebileceği
// için worker daha geniş bir kapanma penceresi kullanır. Docker-compose'daki
// stop_grace_period değerleriyle hizalı: api=30s, worker=60s.
const isWorker = (process.env.BCMS_BACKGROUND_SERVICES ?? 'none') !== 'none';
const SHUTDOWN_TIMEOUT_MS = isWorker ? 60_000 : 30_000;

const start = async () => {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Kapatma sinyali alındı — graceful shutdown başlıyor');

    const forceExit = setTimeout(() => {
      app.log.error('Graceful shutdown zaman aşımı — zorla kapatılıyor');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      await app.close();
      app.log.info('BCMS API güvenle kapatıldı');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Kapatma sırasında hata');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  try {
    const port = parseInt(process.env.PORT ?? '3000', 10);
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`BCMS API running on port ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
