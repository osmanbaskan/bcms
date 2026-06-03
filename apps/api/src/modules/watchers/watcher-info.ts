/**
 * Watcher bağlantı bilgisi — BXF (Provys) ve ASRUN dosya izleyicileri.
 *
 * Bu izleyiciler WORKER container'ında çalışır; izledikleri klasör host-mount
 * (docker volume) ve config'i worker başlangıcında env'den okunur. Ayarlar
 * ekranı bunları SALT-OKUNUR gösterir + canlı durum (worker /health/live'dan
 * proxy ile). Klasör/mount ops tarafından yönetilir; UI'dan değiştirilmez.
 *
 * Config kaynağı: PROVYS_* / ASRUN_* env (provys.watcher.ts & asrun.watcher.ts
 * ile AYNI anahtar + default'lar — tek doğruluk kaynağı .env). api container'ı
 * da bu env'leri alır (docker-compose) ki efektif değer worker ile eş olsun.
 */

/** Watcher salt-okunur yapılandırması (env'den). */
export interface WatcherConfig {
  /** UI anahtarı. */
  key: 'provys' | 'asrun';
  /** Görünen ad. */
  label: string;
  /** service-heartbeat'teki servis adı (durum eşlemesi için). */
  service: 'provys-watcher' | 'asrun-watcher';
  /** İzlenen klasör (container içi mount yolu). */
  watchFolder: string;
  /** chokidar polling modu mu (false → native fs events). */
  usePolling: boolean;
  /** Polling aralığı (ms) — yalnız usePolling=true iken anlamlı. */
  pollIntervalMs: number;
  /** Dosya debounce (ms). */
  debounceMs: number;
  /** Eşzamanlı işlenen dosya sayısı. */
  concurrency: number;
}

/** provys.watcher.ts / asrun.watcher.ts ile aynı boolean parse semantiği. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function parseIntEnv(raw: string | undefined, fallback: number, min = 0): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Env'den iki watcher'ın efektif config'ini üretir. Default'lar watcher
 * modülleriyle birebir (PROVYS_WATCH_FOLDER ./tmp/provys, polling 30sn, …).
 */
export function getWatcherConfigs(env: NodeJS.ProcessEnv = process.env): WatcherConfig[] {
  return [
    {
      key: 'provys',
      label: 'BXF / Provys Watcher',
      service: 'provys-watcher',
      watchFolder:    env.PROVYS_WATCH_FOLDER?.trim() || './tmp/provys',
      usePolling:     parseBool(env.PROVYS_WATCHER_USE_POLLING, false),
      pollIntervalMs: parseIntEnv(env.PROVYS_WATCHER_POLL_INTERVAL_MS, 30_000, 1),
      debounceMs:     parseIntEnv(env.PROVYS_WATCHER_DEBOUNCE_MS, 1_500, 0),
      concurrency:    Math.max(1, parseIntEnv(env.PROVYS_WATCHER_CONCURRENCY, 3, 1)),
    },
    {
      key: 'asrun',
      label: 'ASRUN Watcher',
      service: 'asrun-watcher',
      watchFolder:    env.ASRUN_WATCH_FOLDER?.trim() || './tmp/asrun',
      usePolling:     parseBool(env.ASRUN_WATCHER_USE_POLLING, false),
      pollIntervalMs: parseIntEnv(env.ASRUN_WATCHER_POLL_INTERVAL_MS, 30_000, 1),
      debounceMs:     parseIntEnv(env.ASRUN_WATCHER_DEBOUNCE_MS, 1_500, 0),
      concurrency:    Math.max(1, parseIntEnv(env.ASRUN_WATCHER_CONCURRENCY, 3, 1)),
    },
  ];
}
