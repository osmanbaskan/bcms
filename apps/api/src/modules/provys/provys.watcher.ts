import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { als } from '../../plugins/audit.js';
import { syncChannelDate } from './provys.service.js';
import { extractFileCode, resolveChannel } from './provys.channel-mapping.js';
import { extractScheduleRange } from './provys.file-resolver.js';
import { startHeartbeatTicker } from '../../lib/service-heartbeat.js';
import { ConcurrencyLimiter } from './provys.concurrency.js';
import { startWatcherSupervisor, type SupervisedWatcher } from '../../lib/watcher-supervisor.js';
import { getEffectiveWatchFolders } from '../watchers/watcher.settings.js';

const DEBOUNCE_MS = Number(process.env.PROVYS_WATCHER_DEBOUNCE_MS ?? '1500');
const CONCURRENCY = Math.max(1, Number(process.env.PROVYS_WATCHER_CONCURRENCY ?? '3'));

/**
 * Env'den boolean parse — '1' / 'true' / 'yes' / 'on' (case-insensitive)
 * truthy; geri kalan her şey false. PROVYS_WATCHER_USE_POLLING için
 * CIFS/SMB mount'larda inotify event'leri tetiklenmediği için manuel
 * polling açma sviç'i.
 */
export function parseBoolEnv(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Sayısal env parse — geçersiz / negatif / NaN → fallback. Polling interval
 * 0/negatif olamaz (chokidar 0 verilirse her tick'te disk taraması yapar →
 * IO bombardımanı). Defansif clamp ile minimum 1000 ms zorlanır.
 */
export function parsePollIntervalMs(raw: string | undefined, fallback = 30_000): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1000, Math.trunc(n));
}

const USE_POLLING = parseBoolEnv(process.env.PROVYS_WATCHER_USE_POLLING, false);
const POLL_INTERVAL_MS = parsePollIntervalMs(process.env.PROVYS_WATCHER_POLL_INTERVAL_MS, 30_000);

/**
 * Worker bağlamında çalışan dosya izleyici. İzlenen klasör
 * `watcher_settings.provys_watch_folder` (override) ya da `PROVYS_WATCH_FOLDER`
 * env'inden gelir; supervisor ~30 sn'de bir DB'yi okuyup klasör değişince canlı
 * yeniden izler (restart yok). Host-side CIFS mount + Docker bind volume ile
 * klasör container içinde lokal path olarak görünür.
 *
 * Audit ext aktif — yazımlar ALS context ile actor 'system:provys-watcher'.
 * Defansif: dizin yoksa worker süreci çökertilmez; kontrollü warn loglanır.
 */
export function startProvysWatcher(app: FastifyInstance): void {
  startHeartbeatTicker('provys-watcher', app);
  startWatcherSupervisor({
    service: 'provys-watcher',
    app,
    resolveFolder: async () => (await getEffectiveWatchFolders(app.prisma)).provys,
    createWatcher: (folder) => buildProvysWatcher(app, folder),
  });
}

/** Verilen klasör için chokidar + handler'ları kurar (supervisor çağırır). */
function buildProvysWatcher(app: FastifyInstance, folder: string): SupervisedWatcher {
  // CIFS/SMB mount'lar inotify event'lerini güvenilir taşımaz;
  // PROVYS_WATCHER_USE_POLLING=true ile chokidar polling moduna alınır.
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
        { userId: 'system:provys-watcher', pendingAuditLogs: [] },
        () => { fn().then(resolve, reject); },
      );
    });
  };

  /**
   * Debounce key: `fileCode + scheduleDate`. Initial scan'de chokidar bir
   * burst halinde 500+ add event'i fırlatır; aynı kanal+gün group'una ait
   * çoklu event tek sync'e indirgenir.
   */
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const debounceKey = (fileCode: string, scheduleDate: string) => `${fileCode}|${scheduleDate}`;

  /**
   * Eş zamanlı sync sayısını sınırla — 150+ group debounce timer'ı aynı
   * anda ateşlendiğinde Prisma connection pool (worker default 5) tükenir
   * ve P2024 fırlar. CONCURRENCY (default 3) ile burst FIFO sıralanır.
   */
  const limiter = new ConcurrencyLimiter(CONCURRENCY);

  /**
   * Composed snapshot sync — folder'daki o kanal için tüm aday dosyalardan
   * (target day + bir önceki gün) latest-wins coverage merge çalıştırır.
   * `syncChannelDate` snapshot boşsa o gün satırlarını temizler. Klasör
   * supervisor tarafından sağlanır (canlı değişebilir).
   */
  const flushGroup = async (
    channelSlug: string,
    scheduleDate: string,
    triggerFile: string,
    op: 'add' | 'change' | 'unlink',
  ): Promise<void> => {
    try {
      await runWithAuditContext(async () => {
        await syncChannelDate(
          app.prisma,
          channelSlug as Parameters<typeof syncChannelDate>[1],
          scheduleDate,
          folder,
          app.log,
        );
      });
    } catch (err) {
      app.log.error(
        { err, channelSlug, scheduleDate, triggerFile, op },
        'Provys watcher: sync hatası',
      );
    }
  };

  /**
   * Bir filesystem event'i — `(channel, fileNameDate, fileNameDate+1)`
   * günlerini etkileyebilir. Debounce `(fileCode, scheduleDate)` scope'lu.
   */
  const handle = (filePath: string, op: 'add' | 'change' | 'unlink'): void => {
    if (path.extname(filePath).toLowerCase() !== '.bxf') return;
    const fileCode = extractFileCode(filePath);
    if (!fileCode) {
      app.log.debug({ filePath }, 'Provys watcher: .bxf değil veya kod çıkarılamadı, atlandı');
      return;
    }
    const channel = resolveChannel(fileCode);
    if (!channel) {
      app.log.warn({ filePath, fileCode }, 'Provys watcher: bilinmeyen file code, import edilmedi');
      return;
    }
    const range = extractScheduleRange(filePath);
    if (!range) {
      app.log.warn({ filePath, fileCode }, 'Provys watcher: dosya adından tarih/aralık çıkartılamadı, atlandı');
      return;
    }
    // Çoklu-gün (2026-06-11): [from .. to+1] günleri senkronlanır. Tek-gün
    // dosyada from=to → eski {adGünü, adGünü+1} davranışıyla birebir aynı.
    // Aralık tavanı (31 gün) resolver'da garanti → en çok 32 gün-senkronu.
    const affectedDates: string[] = [];
    for (let d = range.from; d <= addDays(range.to, 1); d = addDays(d, 1)) {
      affectedDates.push(d);
    }
    for (const scheduleDate of affectedDates) {
      const key = debounceKey(fileCode, scheduleDate);
      const existing = debounceTimers.get(key);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        debounceTimers.delete(key);
        void limiter.run(() => flushGroup(channel.slug, scheduleDate, filePath, op));
      }, DEBOUNCE_MS);
      if (typeof timer.unref === 'function') timer.unref();
      debounceTimers.set(key, timer);
    }
  };

  function addDays(date: string, n: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  watcher.on('add',    (p: string) => handle(p, 'add'));
  watcher.on('change', (p: string) => handle(p, 'change'));
  watcher.on('unlink', (p: string) => handle(p, 'unlink'));

  watcher.on('error', (err: unknown) => {
    app.log.error({ err }, 'Provys watcher: izleyici hatası');
  });

  const cleanup = (): void => {
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
  };

  app.log.info(
    { folder, usePolling: USE_POLLING, pollIntervalMs: POLL_INTERVAL_MS, debounceMs: DEBOUNCE_MS, concurrency: CONCURRENCY },
    'Provys watcher: klasör izleyici kuruldu',
  );

  return { watcher, cleanup };
}
