import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { als } from '../../plugins/audit.js';
import { ingestAsrunFile } from './asrun.service.js';
import { parseAsrunFilename } from './asrun.filename.js';
import { ConcurrencyLimiter } from '../provys/provys.concurrency.js';
import { parseBoolEnv, parsePollIntervalMs } from '../provys/provys.watcher.js';
import { startHeartbeatTicker } from '../../lib/service-heartbeat.js';
import { startWatcherSupervisor, type SupervisedWatcher } from '../../lib/watcher-supervisor.js';
import { getEffectiveWatchFolders } from '../watchers/watcher.settings.js';

// Klasör DIŞINDAKİ ayarlar env-sabit (editable değil). İzlenen klasör artık
// watcher_settings DB'sinden okunur (supervisor canlı re-watch eder).
const DEBOUNCE_MS      = Number(process.env.ASRUN_WATCHER_DEBOUNCE_MS ?? '1500');
const CONCURRENCY      = Math.max(1, Number(process.env.ASRUN_WATCHER_CONCURRENCY ?? '3'));
const USE_POLLING      = parseBoolEnv(process.env.ASRUN_WATCHER_USE_POLLING, false);
const POLL_INTERVAL_MS = parsePollIntervalMs(process.env.ASRUN_WATCHER_POLL_INTERVAL_MS, 30_000);

/**
 * Asrun BXF dosya izleyici — worker container.
 *
 * Provys watcher'dan tamamen ayrı (ayrı klasör, debounce, concurrency, audit
 * actor). İzlenen klasör `watcher_settings.asrun_watch_folder` (override) ya da
 * `ASRUN_WATCH_FOLDER` env'inden gelir; supervisor ~30 sn'de bir DB'yi okuyup
 * klasör değişince canlı yeniden izler (restart yok). Mount eksikse kontrollü
 * warn ile izleme durdurulur, container crash'lemez.
 */
export function startAsrunWatcher(app: FastifyInstance): void {
  startHeartbeatTicker('asrun-watcher', app);
  startWatcherSupervisor({
    service: 'asrun-watcher',
    app,
    resolveFolder: async () => (await getEffectiveWatchFolders(app.prisma)).asrun,
    createWatcher: (folder) => buildAsrunWatcher(app, folder),
  });
}

/** Verilen klasör için chokidar + handler'ları kurar (supervisor çağırır). */
function buildAsrunWatcher(app: FastifyInstance, folder: string): SupervisedWatcher {
  const watcher = chokidar.watch(folder, {
    persistent: true,
    ignoreInitial: false,
    usePolling: USE_POLLING,
    interval: POLL_INTERVAL_MS,
    binaryInterval: POLL_INTERVAL_MS,
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
  });

  const runWithAuditContext = async (fn: () => Promise<void>): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      als.run(
        { userId: 'system:asrun-watcher', pendingAuditLogs: [] },
        () => { fn().then(resolve, reject); },
      );
    });
  };

  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const limiter = new ConcurrencyLimiter(CONCURRENCY);

  const flushFile = async (filePath: string, op: 'add' | 'change' | 'unlink'): Promise<void> => {
    if (op === 'unlink') {
      // Asrun'da DELETE yapılmaz — dosya silinmesi geçmiş kaydı düşürmez.
      app.log.debug({ filePath, op }, 'Asrun watcher: unlink atlandı (kayıt korunur)');
      return;
    }
    try {
      // Dosya hâlâ mevcut mu (race)?
      if (!fs.existsSync(filePath)) {
        app.log.debug({ filePath }, 'Asrun watcher: dosya artık yok, atlandı');
        return;
      }
      await runWithAuditContext(async () => {
        await ingestAsrunFile(app.prisma, filePath, app.log);
      });
    } catch (err) {
      app.log.error({ err, filePath, op }, 'Asrun watcher: ingest hatası');
    }
  };

  const handle = (filePath: string, op: 'add' | 'change' | 'unlink'): void => {
    if (path.extname(filePath).toLowerCase() !== '.bxf') return;
    // Asrun-specific filename şeması — Provys helper yok; parseAsrunFilename
    // null dönerse sessizce skip (Outbox/Ok dizinine düşen non-asrun dosyalar
    // veya kanal prefix'i tanınmayan playlist'ler).
    const fn = parseAsrunFilename(filePath);
    if (!fn) {
      app.log.warn({ filePath }, 'Asrun watcher: dosya adı çözülemedi, atlandı');
      return;
    }
    const key = filePath; // dosya bazlı debounce — Asrun'da composed merge yok
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      void limiter.run(() => flushFile(filePath, op));
    }, DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    debounceTimers.set(key, timer);
  };

  watcher.on('add',    (p: string) => handle(p, 'add'));
  watcher.on('change', (p: string) => handle(p, 'change'));
  watcher.on('unlink', (p: string) => handle(p, 'unlink'));

  watcher.on('error', (err: unknown) => {
    app.log.error({ err }, 'Asrun watcher: izleyici hatası');
  });

  // Lifecycle supervisor'da: cleanup debounce timer'larını temizler, watcher'ı
  // supervisor close eder (klasör değişimi veya onClose).
  const cleanup = (): void => {
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
  };

  app.log.info(
    { folder, usePolling: USE_POLLING, pollIntervalMs: POLL_INTERVAL_MS, debounceMs: DEBOUNCE_MS, concurrency: CONCURRENCY },
    'Asrun watcher: klasör izleyici kuruldu',
  );

  return { watcher, cleanup };
}
