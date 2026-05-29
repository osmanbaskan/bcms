import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { als } from '../../plugins/audit.js';
import { syncChannelDate } from './provys.service.js';
import { extractFileCode, resolveChannel } from './provys.channel-mapping.js';
import { extractScheduleDate } from './provys.file-resolver.js';
import { startHeartbeatTicker } from '../../lib/service-heartbeat.js';
import { ConcurrencyLimiter } from './provys.concurrency.js';

const WATCH_FOLDER = process.env.PROVYS_WATCH_FOLDER ?? './tmp/provys';
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
 * Worker bağlamında çalışan dosya izleyici. Host-side CIFS mount + Docker
 * bind volume ile PROVYS_WATCH_FOLDER container içinde lokal path olarak
 * görünür; izleyici Samba protokolüne dokunmaz (filesystem watch yeterli).
 *
 * Audit ext aktif — yazımlar ALS context ile sarmalanarak actor
 * 'system:provys-watcher' olarak işaretlenir.
 *
 * Defansif: dizin yoksa worker süreci çökertilmez; kontrollü warn loglanır
 * ve izleyici başlatılmaz.
 */
export function startProvysWatcher(app: FastifyInstance): void {
  startHeartbeatTicker('provys-watcher', app);
  if (!fs.existsSync(WATCH_FOLDER)) {
    app.log.warn(
      { folder: WATCH_FOLDER },
      'Provys watcher: PROVYS_WATCH_FOLDER mevcut değil; izleyici başlatılmadı (ops mount eksik?)',
    );
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(WATCH_FOLDER);
  } catch (err) {
    app.log.warn({ err, folder: WATCH_FOLDER }, 'Provys watcher: stat hatası; izleyici başlatılmadı');
    return;
  }
  if (!stat.isDirectory()) {
    app.log.warn({ folder: WATCH_FOLDER }, 'Provys watcher: PROVYS_WATCH_FOLDER dizin değil; izleyici başlatılmadı');
    return;
  }

  // CIFS/SMB mount'lar inotify event'lerini başka client'ların yazımı için
  // güvenilir taşımaz; PROVYS_WATCHER_USE_POLLING=true ile chokidar polling
  // moduna alınır. `interval` ve `binaryInterval` tarayıcının dosya keşfi
  // sıklığını yönetir (default 30 sn). `awaitWriteFinish` ayrı bir kontrol —
  // bir kez tetiklenen yazımın boyutu sabitlenene kadar event geciktirilir,
  // bu yüzden write-stability poll'u (500 ms) ayrı tutuldu.
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
   * `syncChannelDate` snapshot boşsa o gün satırlarını temizler.
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
          WATCH_FOLDER,
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
   * günlerini etkileyebilir: dosya kendi günü için kaynak; aynı dosya gece
   * yarısı sonrası event'leri ile bir sonraki güne de katkı yapabilir
   * (per-event `broadcastDate`). Debounce hala `(fileCode, scheduleDate)`
   * scope'lu — aynı gün için art arda gelen event'ler tek sync'e indirgenir.
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
    const filenameDate = extractScheduleDate(filePath);
    if (!filenameDate) {
      app.log.warn({ filePath, fileCode }, 'Provys watcher: dosya adından tarih çıkartılamadı, atlandı');
      return;
    }
    const nextDate = addDays(filenameDate, 1);
    for (const scheduleDate of [filenameDate, nextDate]) {
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

  app.addHook('onClose', async () => {
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    try {
      await watcher.close();
      app.log.info('Provys watcher kapandı');
    } catch (err) {
      app.log.warn({ err }, 'Provys watcher close hatası');
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
    'Provys watcher başlatıldı',
  );
}
