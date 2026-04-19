import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { OPTA_DIR, clearOptaCache } from './opta.parser.js';

const OPTA_EXTENSIONS = new Set(['.xml', '.json']);

// Sık değişen dosyalar için debounce — 5 sn içinde gelen değişiklikleri tek seferinde işle
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(app: FastifyInstance, reason: string) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    app.log.info({ reason }, 'OPTA cache temizlendi, yeni dosya algılandı');
    clearOptaCache();
    debounceTimer = null;
  }, 5000);
}

export function startOptaWatcher(app: FastifyInstance): void {
  const watcher = chokidar.watch(OPTA_DIR, {
    persistent:    true,
    ignoreInitial: true,
    depth:         1,
    awaitWriteFinish: {
      stabilityThreshold: 3000,
      pollInterval:        500,
    },
    // SMB share'ler için polling daha güvenilir
    usePolling:       true,
    interval:         30_000,   // 30 sn'de bir kontrol et
    binaryInterval:   60_000,
  });

  watcher.on('add', (filePath: string) => {
    if (!OPTA_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf('.')).toLowerCase())) return;
    app.log.info({ filePath }, 'OPTA: yeni dosya');
    scheduleRefresh(app, `add:${filePath}`);
  });

  watcher.on('change', (filePath: string) => {
    if (!OPTA_EXTENSIONS.has(filePath.slice(filePath.lastIndexOf('.')).toLowerCase())) return;
    app.log.info({ filePath }, 'OPTA: dosya güncellendi');
    scheduleRefresh(app, `change:${filePath}`);
  });

  watcher.on('unlink', (filePath: string) => {
    app.log.info({ filePath }, 'OPTA: dosya silindi');
    scheduleRefresh(app, `unlink:${filePath}`);
  });

  watcher.on('error', (err: unknown) => {
    app.log.warn({ err, dir: OPTA_DIR }, 'OPTA watcher hatası (share erişilemiyor olabilir)');
  });

  watcher.on('ready', () => {
    app.log.info({ dir: OPTA_DIR }, 'OPTA dizini izleniyor');
  });
}
