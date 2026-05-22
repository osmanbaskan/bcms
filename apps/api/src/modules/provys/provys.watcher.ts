import fs from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import type { FastifyInstance } from 'fastify';
import { als } from '../../plugins/audit.js';
import { clearChannelSnapshot, syncProvysFile } from './provys.service.js';
import { extractFileCode, resolveChannel } from './provys.channel-mapping.js';
import { listBxfFiles, pickLatestForFileCode } from './provys.file-resolver.js';

const WATCH_FOLDER = process.env.PROVYS_WATCH_FOLDER ?? './tmp/provys';

/**
 * Worker bağlamında çalışan dosya izleyici. Host-side CIFS mount + Docker
 * bind volume ile PROVYS_WATCH_FOLDER container içinde lokal path olarak
 * görünür; izleyici Samba protokolüne dokunmaz (filesystem watch yeterli).
 *
 * Audit ext aktif — yazımlar ALS context ile sarmalanarak actor
 * 'system:provys-watcher' olarak işaretlenir.
 *
 * Defansif: dizin yoksa worker süreci çökertilmez; kontrollü warn loglanır
 * ve izleyici başlatılmaz. Ops mount'u sonradan kurarsa worker restart
 * gerekir (mevcut ingest-watcher davranışıyla aynı).
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

  const watcher = chokidar.watch(WATCH_FOLDER, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
  });

  const runWithAuditContext = async (fn: () => Promise<void>): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      als.run(
        { userId: 'system:provys-watcher', pendingAuditLogs: [] },
        () => {
          fn().then(resolve, reject);
        },
      );
    });
  };

  /**
   * Event-bazlı orchestrator. fileCode bazında dizinin tamamını yeniden
   * tarayıp **en güncel mtime'lı** dosyayı seçer ve sadece onu sync eder.
   * Bu sayede:
   *   - Eski mtime'lı bir dosyaya `change` event'i gelirse yeni snapshot
   *     geriye düşmez (resolver halen yeniyi seçer).
   *   - En güncel dosya silinirse, dizinde aynı kanala ait bir sonraki en
   *     güncel dosya seçilir ve onun snapshot'ı yazılır.
   *   - Kanala ait hiç dosya kalmazsa snapshot temizlenir.
   */
  const handle = async (filePath: string, op: 'add' | 'change' | 'unlink'): Promise<void> => {
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

    try {
      const files = await listBxfFiles(WATCH_FOLDER);
      const latest = pickLatestForFileCode(files, fileCode);

      await runWithAuditContext(async () => {
        if (!latest) {
          // Kanala ait dosya kalmadı → snapshot temizle.
          app.log.info(
            { channelSlug: channel.slug, fileCode, op, triggerFile: filePath },
            'Provys watcher: kanal için BXF kalmadı, snapshot temizleniyor',
          );
          await clearChannelSnapshot(app.prisma, channel.slug, app.log);
          return;
        }
        if (latest.path !== filePath) {
          app.log.debug(
            { triggerFile: filePath, selectedFile: latest.path, fileCode, op },
            'Provys watcher: event eski mtime; daha güncel dosya seçildi',
          );
        }
        await syncProvysFile(app.prisma, latest.path, app.log);
      });
    } catch (err) {
      app.log.error({ err, filePath, op }, 'Provys watcher: sync hatası');
    }
  };

  watcher.on('add',    (p: string) => { void handle(p, 'add'); });
  watcher.on('change', (p: string) => { void handle(p, 'change'); });
  watcher.on('unlink', (p: string) => { void handle(p, 'unlink'); });

  watcher.on('error', (err: unknown) => {
    app.log.error({ err }, 'Provys watcher: izleyici hatası');
  });

  app.addHook('onClose', async () => {
    try {
      await watcher.close();
      app.log.info('Provys watcher kapandı');
    } catch (err) {
      app.log.warn({ err }, 'Provys watcher close hatası');
    }
  });

  app.log.info({ folder: WATCH_FOLDER }, 'Provys watcher başlatıldı');
}
