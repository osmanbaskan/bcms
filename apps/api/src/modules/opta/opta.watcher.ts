import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { OPTA_DIR, clearOptaCache } from './opta.parser.js';

// FUSE mount üzerinde 448K+ dosya olduğundan chokidar ile polling yapmak
// Node'u D-state'e sokar. Bunun yerine periyodik cache temizleme kullanıyoruz.
const CACHE_REFRESH_MS  = 5 * 60 * 1000;   // 5 dakikada bir cache sıfırla
const HEALTH_CHECK_MS   = 30 * 1000;        // 30 sn'de bir dizin erişimini kontrol et

let isConnected = false;

export function getOptaWatcherStatus(): { connected: boolean; dir: string } {
  return { connected: isConnected, dir: OPTA_DIR };
}

async function checkDir(): Promise<boolean> {
  try {
    await fs.stat(OPTA_DIR);
    return true;
  } catch {
    return false;
  }
}

function startTimers(app: FastifyInstance) {
  setInterval(() => {
    checkDir().then((ok) => {
      if (!ok) {
        app.log.warn({ dir: OPTA_DIR }, 'OPTA dizinine erişilemiyor');
        isConnected = false;
        return;
      }
      clearOptaCache();
      app.log.info({ dir: OPTA_DIR }, 'OPTA cache periyodik olarak temizlendi');
    }).catch(() => { isConnected = false; });
  }, CACHE_REFRESH_MS);

  setInterval(() => {
    checkDir().then((ok) => {
      if (ok !== isConnected) {
        isConnected = ok;
        app.log.info({ dir: OPTA_DIR, connected: ok }, 'OPTA bağlantı durumu değişti');
        if (ok) clearOptaCache();
      }
    }).catch(() => { isConnected = false; });
  }, HEALTH_CHECK_MS);
}

export async function startOptaWatcher(app: FastifyInstance): Promise<void> {
  const ok = await checkDir();
  if (!ok) {
    app.log.warn({ dir: OPTA_DIR }, 'OPTA dizinine erişilemiyor, periyodik kontrol başlatılıyor');
    isConnected = false;
  } else {
    isConnected = true;
    app.log.info({ dir: OPTA_DIR }, 'OPTA dizini hazır (periyodik cache yenileme aktif)');
  }

  startTimers(app);
}
