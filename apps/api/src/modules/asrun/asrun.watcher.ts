import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { als } from '../../plugins/audit.js';
import { ingestAsrunFile } from './asrun.service.js';
import { extractFileCode, resolveChannel } from '../provys/provys.channel-mapping.js';
import { ConcurrencyLimiter } from '../provys/provys.concurrency.js';
import { parseBoolEnv, parsePollIntervalMs } from '../provys/provys.watcher.js';

const WATCH_FOLDER     = process.env.ASRUN_WATCH_FOLDER ?? './tmp/asrun';
const DEBOUNCE_MS      = Number(process.env.ASRUN_WATCHER_DEBOUNCE_MS ?? '1500');
const CONCURRENCY      = Math.max(1, Number(process.env.ASRUN_WATCHER_CONCURRENCY ?? '3'));
const USE_POLLING      = parseBoolEnv(process.env.ASRUN_WATCHER_USE_POLLING, false);
const POLL_INTERVAL_MS = parsePollIntervalMs(process.env.ASRUN_WATCHER_POLL_INTERVAL_MS, 30_000);

/**
 * Asrun BXF dosya izleyici — worker container.
 *
 * Provys watcher'dan tamamen ayrı:
 *   - Ayrı `WATCH_FOLDER`  (ASRUN_WATCH_FOLDER → SMB Outbox/Ok mount).
 *   - Ayrı debounce map + concurrency limiter.
 *   - Audit actor: `system:asrun-watcher`.
 *   - Composed snapshot merge YOK; service.ingestAsrunFile dosya başına
 *     idempotent upsert yapar.
 *
 * SMB üzerinde inotify event delivery güvensiz (`PROVYS_*` ile aynı sebep)
 * — `ASRUN_WATCHER_USE_POLLING=true` ile chokidar polling moduna alınır.
 * Mount yoksa watcher kontrollü warn ile başlatılmaz; container crash'lemez.
 */
export function startAsrunWatcher(app: FastifyInstance): void {
  if (!fs.existsSync(WATCH_FOLDER)) {
    app.log.warn(
      { folder: WATCH_FOLDER },
      'Asrun watcher: ASRUN_WATCH_FOLDER mevcut değil; izleyici başlatılmadı (ops mount eksik?)',
    );
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(WATCH_FOLDER);
  } catch (err) {
    app.log.warn({ err, folder: WATCH_FOLDER }, 'Asrun watcher: stat hatası; izleyici başlatılmadı');
    return;
  }
  if (!stat.isDirectory()) {
    app.log.warn({ folder: WATCH_FOLDER }, 'Asrun watcher: ASRUN_WATCH_FOLDER dizin değil; izleyici başlatılmadı');
    return;
  }

  const watcher = chokidar.watch(WATCH_FOLDER, {
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
    const fileCode = extractFileCode(filePath);
    if (!fileCode) {
      app.log.debug({ filePath }, 'Asrun watcher: .bxf değil veya kod çıkarılamadı, atlandı');
      return;
    }
    const channel = resolveChannel(fileCode);
    if (!channel) {
      app.log.warn({ filePath, fileCode }, 'Asrun watcher: bilinmeyen file code, import edilmedi');
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

  app.addHook('onClose', async () => {
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    try {
      await watcher.close();
      app.log.info('Asrun watcher kapandı');
    } catch (err) {
      app.log.warn({ err }, 'Asrun watcher close hatası');
    }
  });

  app.log.info(
    {
      folder: WATCH_FOLDER,
      usePolling: USE_POLLING,
      pollIntervalMs: POLL_INTERVAL_MS,
      debounceMs: DEBOUNCE_MS,
      concurrency: CONCURRENCY,
    },
    'Asrun watcher başlatıldı',
  );
}
