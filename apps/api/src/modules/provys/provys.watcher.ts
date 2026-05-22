import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { als } from '../../plugins/audit.js';
import { clearChannelDateSnapshot, syncProvysFile } from './provys.service.js';
import { extractFileCode, resolveChannel } from './provys.channel-mapping.js';
import {
  extractScheduleDate,
  listBxfFiles,
  pickLatestForFileCodeAndDate,
} from './provys.file-resolver.js';
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
   * Bir `(channelSlug, scheduleDate)` group için latest BXF revision'ı sync
   * eder veya hiç dosya kalmadıysa o gün snapshot'ını temizler. Başka
   * günlere DOKUNMAZ.
   */
  const flushGroup = async (
    fileCode: string,
    channelSlug: string,
    scheduleDate: string,
    triggerFile: string,
    op: 'add' | 'change' | 'unlink',
  ): Promise<void> => {
    try {
      const files = await listBxfFiles(WATCH_FOLDER);
      const latest = pickLatestForFileCodeAndDate(files, fileCode, scheduleDate);
      await runWithAuditContext(async () => {
        if (!latest) {
          app.log.info(
            { channelSlug, scheduleDate, fileCode, op, triggerFile },
            'Provys watcher: kanal+gün için BXF kalmadı, snapshot temizleniyor',
          );
          await clearChannelDateSnapshot(app.prisma, channelSlug, scheduleDate, app.log);
          return;
        }
        if (latest.path !== triggerFile) {
          app.log.debug(
            { triggerFile, selectedFile: latest.path, fileCode, scheduleDate, op },
            'Provys watcher: event eski revision; aynı gün daha güncel dosya seçildi',
          );
        }
        await syncProvysFile(app.prisma, latest.path, app.log);
      });
    } catch (err) {
      app.log.error({ err, fileCode, scheduleDate, triggerFile, op }, 'Provys watcher: sync hatası');
    }
  };

  /**
   * Event-bazlı orchestrator. (fileCode, scheduleDate) group'unu dizinin
   * tamamından yeniden hesaplar; tekrar event geldiğinde timer reset →
   * DEBOUNCE_MS sonra tek atış.
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
    const scheduleDate = extractScheduleDate(filePath);
    if (!scheduleDate) {
      app.log.warn({ filePath, fileCode }, 'Provys watcher: dosya adından tarih çıkartılamadı, atlandı');
      return;
    }

    const key = debounceKey(fileCode, scheduleDate);
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      debounceTimers.delete(key);
      // Limiter ile sarmala — eş zamanlı sync sayısı CONCURRENCY ile sınırlı,
      // diğerleri FIFO sıraya alınır (pool tükenmesi engellenir).
      void limiter.run(() => flushGroup(fileCode, channel.slug, scheduleDate, filePath, op));
    }, DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    debounceTimers.set(key, timer);
  };

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
