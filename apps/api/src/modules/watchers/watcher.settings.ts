/**
 * Watcher izlenen klasör override'ları — DB (tek satır `watcher_settings`, id=1).
 *
 * Ayarlar > Bağlantılar ekranından düzenlenir. Boş/null alan runtime'da env'e
 * (PROVYS_WATCH_FOLDER / ASRUN_WATCH_FOLDER) düşer. Watcher worker'da bu değeri
 * periyodik okur (canlı re-watch). Sır içermez (yalnız klasör yolu).
 */
import type { PrismaClient } from '@prisma/client';

/** Provys/ASRUN watcher'ın env default klasörü (watcher modülleriyle eş). */
export const ENV_DEFAULT_PROVYS_FOLDER = () =>
  process.env.PROVYS_WATCH_FOLDER?.trim() || './tmp/provys';
export const ENV_DEFAULT_ASRUN_FOLDER = () =>
  process.env.ASRUN_WATCH_FOLDER?.trim() || './tmp/asrun';

const nz = (v: string | null | undefined): string | undefined => {
  const t = (v ?? '').trim();
  return t === '' ? undefined : t;
};

/** Efektif (DB override → env fallback) izlenen klasörler. */
export interface EffectiveWatchFolders {
  provys: string;
  asrun: string;
}

/**
 * DB override + env merge edilmiş efektif klasörler. Watcher worker bunu
 * periyodik çağırır; route GET de input başlangıç değeri için kullanır.
 */
export async function getEffectiveWatchFolders(
  prisma: PrismaClient,
): Promise<EffectiveWatchFolders> {
  const row = await prisma.watcherSetting.findUnique({ where: { id: 1 } });
  return {
    provys: nz(row?.provysWatchFolder) ?? ENV_DEFAULT_PROVYS_FOLDER(),
    asrun:  nz(row?.asrunWatchFolder)  ?? ENV_DEFAULT_ASRUN_FOLDER(),
  };
}

/** PUT gövdesi — biri ya da ikisi; boş string → env'e dön (null'a çevrilir). */
export interface WatchFoldersPatch {
  provysWatchFolder?: string;
  asrunWatchFolder?: string;
}

/**
 * Kısmi güncelleme (upsert id=1). '' → null (env'e dön), dolu → kaydet,
 * undefined → dokunma. updatedAt @updatedAt ile değişir.
 */
export async function writeWatchFolders(
  prisma: PrismaClient,
  patch: WatchFoldersPatch,
  user: string | null,
): Promise<void> {
  const data: Record<string, string | null> = {};
  const setPath = (key: string, val: string | undefined) => {
    if (val === undefined) return;
    data[key] = val.trim() === '' ? null : val.trim();
  };
  setPath('provysWatchFolder', patch.provysWatchFolder);
  setPath('asrunWatchFolder',  patch.asrunWatchFolder);

  await prisma.watcherSetting.upsert({
    where:  { id: 1 },
    create: { id: 1, ...data, updatedBy: user },
    update: { ...data, updatedBy: user },
  });
}
