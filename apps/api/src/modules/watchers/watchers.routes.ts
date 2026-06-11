/**
 * Watcher REST (Ayarlar > Bağlantılar — bilgi + canlı durum + klasör düzenleme).
 *
 *  GET /api/v1/watchers        → BXF (Provys) + ASRUN config (env + DB klasör
 *                                override) + canlı durum (worker proxy).
 *  PUT /api/v1/watchers/folder → izlenen klasör override (DB). Watcher worker'da
 *                                ~30 sn'de bir DB okur → canlı re-watch (restart
 *                                yok). Klasör container'da mount edilmiş olmalı;
 *                                aksi halde folderExists=false döner.
 *
 * Durum, watcher'lar WORKER container'ında çalıştığı için worker'ın iç
 * /internal/watchers endpoint'inden proxy ile alınır (state process-içi).
 *
 * Yetki: read+write yalnız SystemEng (+ Admin auto-bypass). Sır yok (klasör).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS, type JwtPayload } from '@bcms/shared';
import { getWatcherConfigs } from './watcher-info.js';
import {
  getEffectiveWatchFolders,
  getProvysSmbCreds,
  writeWatchFolders,
  type WatchFoldersPatch,
} from './watcher.settings.js';

const WORKER_HEALTH_URL = process.env.BCMS_WORKER_HEALTH_URL ?? 'http://worker:3000';
const PROXY_TIMEOUT_MS = 2_500;

interface WorkerWatcherRuntime {
  effectiveFolder: string | null;
  folderExists: boolean | null;
  watching: boolean | null;
  alive: boolean;
  ageMs: number | null;
  lastTickAt: string | null;
}

const folderPatchSchema = z
  .object({
    provysWatchFolder: z.string().max(500).optional(),
    asrunWatchFolder:  z.string().max(500).optional(),
    // SMB-direct (2026-06-11): provys klasörü smb:// ise kullanılacak kimlik.
    provysSmbUser:     z.string().max(100).optional(),
    provysSmbPassword: z.string().max(300).optional(),
    provysSmbDomain:   z.string().max(100).optional(),
  })
  .strict();

/** GET'te şifre asla dönmez — yalnız set olup olmadığı bildirilir. */
const MASK = '********';

/** Worker /internal/watchers'tan service→runtime haritası. Ulaşılamazsa null. */
async function fetchWorkerRuntime(
  app: FastifyInstance,
): Promise<Record<string, WorkerWatcherRuntime> | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(`${WORKER_HEALTH_URL}/internal/watchers`, { signal: ctrl.signal });
    return (await res.json()) as Record<string, WorkerWatcherRuntime>;
  } catch (err) {
    app.log.warn({ err, url: WORKER_HEALTH_URL }, 'Watcher durumu: worker /internal/watchers alınamadı');
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function buildWatchersDto(app: FastifyInstance) {
  const configs = getWatcherConfigs();
  const folders = await getEffectiveWatchFolders(app.prisma);
  const runtime = await fetchWorkerRuntime(app);
  const reachable = runtime !== null;

  const effFolder = (key: string) => (key === 'provys' ? folders.provys : folders.asrun);

  const watchers = configs.map((cfg) => {
    const rt = runtime?.[cfg.service] ?? null;
    const status: 'alive' | 'dead' | 'unknown' =
      !reachable ? 'unknown' : rt?.alive ? 'alive' : 'dead';
    return {
      ...cfg,
      watchFolder:  effFolder(cfg.key),          // efektif (DB override → env)
      status,
      ageMs:        rt?.ageMs ?? null,
      lastTickAt:   rt?.lastTickAt ?? null,
      folderExists: rt?.folderExists ?? null,    // null → bilinmiyor (worker yok)
      watching:     rt?.watching ?? null,
    };
  });

  // SMB-direct kimlik durumu (yalnız provys; şifre MASKELİ).
  const smb = await getProvysSmbCreds(app.prisma);
  const provysSmb = {
    user: smb.user || null,
    domain: smb.domain || null,
    passwordSet: smb.password !== '',
    password: smb.password !== '' ? MASK : null,
  };

  return { reachable, watchers, provysSmb };
}

export async function watchersRoutes(app: FastifyInstance) {
  // GET /api/v1/watchers — config + efektif klasör + canlı durum
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.watchers.read),
    schema: { tags: ['Watchers'], summary: 'BXF/ASRUN watcher bilgi + canlı durum' },
  }, async () => buildWatchersDto(app));

  // PUT /api/v1/watchers/folder — izlenen klasör override (canlı re-watch)
  app.put<{ Body: WatchFoldersPatch }>('/folder', {
    preHandler: app.requireGroup(...PERMISSIONS.watchers.write),
    schema: { tags: ['Watchers'], summary: 'Watcher izlenen klasörü güncelle' },
  }, async (request) => {
    const patch = folderPatchSchema.parse(request.body);
    // UI maskeyi geri gönderirse şifreye DOKUNMA (news_settings paritesi).
    if (patch.provysSmbPassword === MASK) delete patch.provysSmbPassword;
    const user = (request.user as JwtPayload | undefined)?.preferred_username ?? null;
    await writeWatchFolders(app.prisma, patch, user);
    return buildWatchersDto(app);
  });
}
