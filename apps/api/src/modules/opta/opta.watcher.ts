import fs from 'node:fs';
import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { OPTA_DIR, clearOptaCache } from './opta.parser.js';

const OPTA_EXTENSIONS = new Set(['.xml', '.json']);
const RECONNECT_INTERVAL_MS = 60_000;

let isConnected = false;
let reconnecting = false;
let activeWatcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function getOptaWatcherStatus(): { connected: boolean; dir: string } {
  return { connected: isConnected, dir: OPTA_DIR };
}

function checkDir(): boolean {
  try {
    fs.readdirSync(OPTA_DIR);
    return true;
  } catch {
    return false;
  }
}

function scheduleRefresh(app: FastifyInstance, reason: string) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    app.log.info({ reason }, 'OPTA cache temizlendi, yeni dosya algılandı');
    clearOptaCache();
    debounceTimer = null;
  }, 5000);
}

function reconnect(app: FastifyInstance) {
  if (reconnecting) return;
  reconnecting = true;
  isConnected = false;

  const timer = setInterval(() => {
    if (!checkDir()) return;

    clearInterval(timer);
    reconnecting = false;
    app.log.info({ dir: OPTA_DIR }, 'OPTA dizinine yeniden bağlanıldı');
    startWatcher(app);
  }, RECONNECT_INTERVAL_MS);
}

function startWatcher(app: FastifyInstance) {
  if (activeWatcher) {
    activeWatcher.close().catch(() => {});
    activeWatcher = null;
  }

  if (!checkDir()) {
    app.log.warn({ dir: OPTA_DIR }, 'OPTA dizinine erişilemiyor, yeniden bağlanma bekleniyor');
    reconnect(app);
    return;
  }

  const watcher = chokidar.watch(OPTA_DIR, {
    persistent:    true,
    ignoreInitial: true,
    depth:         1,
    awaitWriteFinish: {
      stabilityThreshold: 3000,
      pollInterval:        500,
    },
    usePolling:     true,
    interval:       30_000,
    binaryInterval: 60_000,
  });

  activeWatcher = watcher;

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
    app.log.warn({ err, dir: OPTA_DIR }, 'OPTA watcher hatası, yeniden bağlanma başlatılıyor');
    isConnected = false;
    reconnect(app);
  });

  watcher.on('ready', () => {
    isConnected = true;
    app.log.info({ dir: OPTA_DIR }, 'OPTA dizini izleniyor');
  });
}

export function startOptaWatcher(app: FastifyInstance): void {
  startWatcher(app);
}
