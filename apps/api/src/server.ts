import { buildApp } from './app.js';

const start = async () => {
  const app = await buildApp();

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
