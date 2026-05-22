import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFileCode } from './provys.channel-mapping.js';

/**
 * Bir kanala (fileCode) ait dizindeki en güncel `.bxf` dosyasını seçen
 * saf yardımcılar. Watcher event'i geldiğinde önce dizindeki tüm BXF
 * dosyaları enumerate edilir, sonra `pickLatestForFileCode` ile en güncel
 * mtime'lı olan seçilir. Bu zincir, eski mtime'lı bir dosya `change`
 * event'i fırlatsa bile snapshot'ın geriye düşmesini engeller:
 *   - Eski event geldi → dizini taradık → halen yenisi mevcut → yeniyi sync.
 *   - En güncel dosya silindi → bir sonraki en güncele düşülür.
 *   - Hiç dosya yoksa → caller kanal snapshot'ını temizler.
 */

export interface BxfFileInfo {
  path: string;
  fileCode: string;
  mtime: Date;
}

/** Dizindeki tüm `.bxf` dosyalarını fileCode + mtime ile listele. */
export async function listBxfFiles(dir: string): Promise<BxfFileInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const out: BxfFileInfo[] = [];
  for (const name of entries) {
    if (path.extname(name).toLowerCase() !== '.bxf') continue;
    const fileCode = extractFileCode(name);
    if (!fileCode) continue;
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      out.push({ path: full, fileCode, mtime: stat.mtime });
    } catch {
      // Race: dosya enumerasyon sonrası silinmiş olabilir; sessiz atla.
    }
  }
  return out;
}

/**
 * Saf: verilen liste içinden `fileCode`'a uyan en güncel mtime'lı dosyayı
 * döner. Hiç eşleşme yoksa `null`. Eşit mtime'da `path` deterministic tie-break.
 */
export function pickLatestForFileCode(
  files: ReadonlyArray<BxfFileInfo>,
  fileCode: string,
): BxfFileInfo | null {
  const normalized = fileCode.trim().toLowerCase();
  let best: BxfFileInfo | null = null;
  for (const f of files) {
    if (f.fileCode !== normalized) continue;
    if (!best) { best = f; continue; }
    if (f.mtime.getTime() > best.mtime.getTime()) {
      best = f;
    } else if (f.mtime.getTime() === best.mtime.getTime() && f.path > best.path) {
      best = f;
    }
  }
  return best;
}
