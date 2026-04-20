import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { OPTA_DIR, clearOptaCache } from './opta.parser.js';

// FUSE mount üzerinde 448K+ dosya olduğundan chokidar ile polling yapmak
// Node'u D-state'e sokar. Bunun yerine periyodik cache temizleme kullanıyoruz.
const CACHE_REFRESH_MS  = 5 * 60 * 1000;   // 5 dakikada bir cache sıfırla
const HEALTH_CHECK_MS   = 30 * 1000;        // 30 sn'de bir dizin erişimini kontrol et

let isConnected = false;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let healthTimer:  ReturnType<typeof setInterval> | null = null;

export function getOptaWatcherStatus(): { connected: boolean; dir: string } {
  return { connected: isConnected, dir: OPTA_DIR };
}

function checkDir(): boolean {
  // accessSync FUSE'da access() syscall'ı tetikler; FUSE default_permissions olmadan bloke edebilir.
  // statSync daha güvenli: sadece getattr() çağırır.
  try {
    fs.statSync(OPTA_DIR);
    return true;
  } catch {
    return false;
  }
}

function startTimers(app: FastifyInstance) {
  refreshTimer = setInterval(() => {
    if (!checkDir()) {
      app.log.warn({ dir: OPTA_DIR }, 'OPTA dizinine erişilemiyor');
      isConnected = false;
      return;
    }
    clearOptaCache();
    app.log.info({ dir: OPTA_DIR }, 'OPTA cache periyodik olarak temizlendi');
  }, CACHE_REFRESH_MS);

  healthTimer = setInterval(() => {
    const ok = checkDir();
    if (ok !== isConnected) {
      isConnected = ok;
      app.log.info({ dir: OPTA_DIR, connected: ok }, 'OPTA bağlantı durumu değişti');
      if (ok) clearOptaCache();
    }
  }, HEALTH_CHECK_MS);
}

export function startOptaWatcher(app: FastifyInstance): void {
  if (!checkDir()) {
    app.log.warn({ dir: OPTA_DIR }, 'OPTA dizinine erişilemiyor, periyodik kontrol başlatılıyor');
    isConnected = false;
  } else {
    isConnected = true;
    app.log.info({ dir: OPTA_DIR }, 'OPTA dizini hazır (periyodik cache yenileme aktif)');
  }

  startTimers(app);
}
