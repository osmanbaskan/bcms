/**
 * Watcher supervisor — canlı izlenen-klasör değişimi (restart yok).
 *
 * BXF/Provys ve ASRUN izleyicileri worker'da çalışır; klasörü `watcher_settings`
 * DB tablosundan (override) ya da env'den okur. Supervisor periyodik (~30 sn)
 * `resolveFolder()` çağırır; klasör değişince eski chokidar'ı kapatıp yeni
 * klasörü izlemeye başlar. Klasör yoksa/dizin değilse izlemeyi durdurur ve
 * `folderExists=false` raporlar (UI uyarısı için).
 *
 * Runtime state module-scope tutulur; worker'ın /internal/watchers endpoint'i
 * okur, API proxy ile UI'a taşır (heartbeat process-içi olduğu gibi).
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';

/**
 * createWatcher dönüşü — izleyici (chokidar FSWatcher VEYA SMB poller gibi
 * close() sunan herhangi bir şey) + cleanup (debounce timer'ları).
 */
export interface SupervisedWatcher {
  watcher: { close(): Promise<unknown> | void };
  cleanup: () => void;
}

/** Worker /internal/watchers'ın döndüğü canlı durum. */
export interface WatcherRuntimeState {
  /** Şu an izlenmeye çalışılan efektif klasör. */
  effectiveFolder: string;
  /** Klasör container içinde mevcut + dizin mi. */
  folderExists: boolean;
  /** chokidar aktif izliyor mu (folderExists + kurulu). */
  watching: boolean;
}

const runtimeStates = new Map<string, WatcherRuntimeState>();

/** Servis adına göre runtime state (yoksa null). */
export function getWatcherRuntimeState(service: string): WatcherRuntimeState | null {
  return runtimeStates.get(service) ?? null;
}

export interface SupervisorOptions {
  /** service-heartbeat servis adı ('provys-watcher' | 'asrun-watcher'). */
  service: string;
  app: FastifyInstance;
  /** Efektif klasörü çözer (DB override → env). Her re-check'te çağrılır. */
  resolveFolder: () => Promise<string>;
  /** Verilen klasör için chokidar + handler'ları kurar. */
  createWatcher: (folder: string) => SupervisedWatcher;
  /** DB/klasör re-check aralığı (ms). Default 30 sn. */
  recheckIntervalMs?: number;
  /** Opsiyonel aktiflik kapısı (ör. asrun: 23:30–02:00 saat penceresi). false
   *  iken watcher kapatılır (polling/CPU durur), true olunca yeniden açılır.
   *  Verilmezse her zaman aktif (eski davranış — provys etkilenmez). */
  isActive?: () => boolean | Promise<boolean>;
}

function isValidDir(folder: string): boolean {
  // smb:// kaynakları fs ile doğrulanamaz — geçerli sayılır; erişim/sağlık
  // sorumluluğu watcher'ın kendi poller'ındadır (2026-06-11 SMB-direct).
  if (/^smb:\/\//i.test(folder)) return true;
  try {
    return fs.existsSync(folder) && fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Supervisor'ı başlatır: ilk apply + periyodik re-check + onClose cleanup.
 * Watcher'ın startHeartbeatTicker'ı çağrıdan ÖNCE kurulmalı (process liveness).
 */
export function startWatcherSupervisor(opts: SupervisorOptions): void {
  const { service, app, resolveFolder, createWatcher } = opts;
  const recheckMs = opts.recheckIntervalMs ?? 30_000;
  let current: { folder: string; sup: SupervisedWatcher } | null = null;

  const setState = (folder: string, exists: boolean, watching: boolean): void => {
    runtimeStates.set(service, { effectiveFolder: folder, folderExists: exists, watching });
  };

  const stopCurrent = async (): Promise<void> => {
    if (!current) return;
    const { sup } = current;
    current = null;
    try {
      sup.cleanup();
      await sup.watcher.close();
    } catch (err) {
      app.log.warn({ err, service }, `${service}: izleyici kapatma hatası`);
    }
  };

  const apply = async (folder: string): Promise<void> => {
    const valid = isValidDir(folder);

    // Aynı klasör + zaten izleniyor → yalnız existence state'i tazele.
    if (current && current.folder === folder) {
      setState(folder, valid, valid);
      return;
    }

    // Klasör değişti (veya ilk kez). Geçersizse: izlemeyi durdur, işaretle.
    if (!valid) {
      await stopCurrent();
      setState(folder, false, false);
      app.log.warn(
        { folder, service },
        `${service}: izlenen klasör yok/dizin değil; izleme durdu (mount eksik?)`,
      );
      return;
    }

    await stopCurrent();
    const sup = createWatcher(folder);
    current = { folder, sup };
    setState(folder, true, true);
    app.log.info({ folder, service }, `${service}: izlenen klasör güncellendi`);
  };

  // isActive (aktif saat penceresi) + folder re-check ortak akışı.
  let pausedLogged = false;
  const runApply = async (): Promise<void> => {
    if (opts.isActive) {
      let active = true;
      try { active = await opts.isActive(); } catch { active = true; } // hata → aktif say (güvenli)
      if (!active) {
        if (current) {
          await stopCurrent();
          app.log.info({ service }, `${service}: aktif pencere dışında — izleme duraklatıldı`);
          pausedLogged = true;
        } else if (!pausedLogged) {
          app.log.info({ service }, `${service}: aktif pencere dışında — izleme başlamadı`);
          pausedLogged = true;
        }
        const f = await resolveFolder().catch(() => '');
        setState(f, isValidDir(f), false);
        return;
      }
      pausedLogged = false; // pencereye girildi
    }
    await apply(await resolveFolder());
  };

  // İlk apply.
  void runApply().catch((err) => app.log.error({ err, service }, `${service}: başlangıç apply hatası`));

  // Periyodik re-check (aktif pencere + DB klasör değişimi + existence).
  const timer = setInterval(() => {
    void runApply().catch((err) => app.log.warn({ err, service }, `${service}: re-check hatası`));
  }, recheckMs);
  if (typeof timer.unref === 'function') timer.unref();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    await stopCurrent();
  });
}
