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

/**
 * Provys SMB-direct kimliği (2026-06-11): provys_watch_folder `smb://` ise
 * watcher bu kimlikle smbclient üzerinden okur. DB override → env fallback
 * (PROVYS_SMB_USER/PASSWORD/DOMAIN). Watcher her smbclient çağrısında taze
 * okur — ayar değişimi restart/rebuild gerektirmez.
 */
export interface ProvysSmbCreds {
  user: string;
  password: string;
  domain: string;
}

export async function getProvysSmbCreds(prisma: PrismaClient): Promise<ProvysSmbCreds> {
  const row = await prisma.watcherSetting.findUnique({ where: { id: 1 } });
  return {
    user:     nz(row?.provysSmbUser)     ?? process.env.PROVYS_SMB_USER?.trim()     ?? '',
    password: nz(row?.provysSmbPassword) ?? process.env.PROVYS_SMB_PASSWORD         ?? '',
    domain:   nz(row?.provysSmbDomain)   ?? process.env.PROVYS_SMB_DOMAIN?.trim()   ?? '',
  };
}

/** PUT gövdesi — alanlardan herhangi biri; boş string → env'e dön (null'a çevrilir). */
export interface WatchFoldersPatch {
  provysWatchFolder?: string;
  asrunWatchFolder?: string;
  provysSmbUser?: string;
  provysSmbPassword?: string;
  provysSmbDomain?: string;
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
  setPath('provysSmbUser',     patch.provysSmbUser);
  setPath('provysSmbPassword', patch.provysSmbPassword);
  setPath('provysSmbDomain',   patch.provysSmbDomain);

  await prisma.watcherSetting.upsert({
    where:  { id: 1 },
    create: { id: 1, ...data, updatedBy: user },
    update: { ...data, updatedBy: user },
  });
}
