import fs from 'node:fs/promises';
import path from 'node:path';
import { extractFileCode } from './provys.channel-mapping.js';

/**
 * BXF dosya seçimi — kanal + gün granülaritesinde "en güncel revision".
 *
 * Provys exporter aynı kanal+gün için birden çok revision üretebiliyor
 * (örn. `BXF_Playlist_LT2_20260217_*_caf.bxf` ve `..._zec.bxf`). Watcher
 * event'i geldiğinde önce dizindeki tüm BXF dosyaları enumerate edilir,
 * sonra `pickLatestForFileCodeAndDate(files, fileCode, scheduleDate)` ile
 * o `(fileCode, scheduleDate)` group'unun en güncel mtime'lı revision'ı
 * seçilir.
 *
 * Sözleşme:
 *   - Eski revision change event'i yeni snapshot'ı GERİYE DÜŞÜRMEZ
 *     (resolver halen latest mtime'ı döner).
 *   - En güncel revision silindiğinde bir önceki revision'a fallback olur.
 *   - O (fileCode, scheduleDate) için hiç dosya kalmazsa null → caller
 *     SADECE o `(channelSlug, scheduleDate)` snapshot'ını temizler;
 *     başka günlere dokunmaz.
 *
 * Dosya adı format sözleşmesi: `BXF_Playlist_<CODE>_<YYYYMMDD>_...bxf`
 * — ilk YYYYMMDD bloğu `scheduleDate` olarak alınır (broadcast day).
 */

export interface BxfFileInfo {
  path: string;
  fileCode: string;
  /** Yayın günü `YYYY-MM-DD` (Europe/Istanbul naive). */
  scheduleDate: string;
  mtime: Date;
}

const FILENAME_DATE_RE = /^BXF_Playlist_[A-Za-z0-9]+_(\d{4})(\d{2})(\d{2})_/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Dosya adından `YYYY-MM-DD` çıkarır. Eski/short form (`ltv-2026-05-22.bxf`)
 * için ikinci pattern denenir. Eşleşme yoksa null.
 */
export function extractScheduleDate(filePath: string): string | null {
  const base = path.basename(filePath);
  // 1) BXF_Playlist_<CODE>_<YYYYMMDD>_...
  const m1 = base.match(FILENAME_DATE_RE);
  if (m1) {
    const iso = `${m1[1]}-${m1[2]}-${m1[3]}`;
    return ISO_DATE_RE.test(iso) ? iso : null;
  }
  // 2) Legacy: <code>-YYYY-MM-DD.bxf
  const m2 = base.match(/^[A-Za-z0-9]+-(\d{4})-(\d{2})-(\d{2})/);
  if (m2) {
    const iso = `${m2[1]}-${m2[2]}-${m2[3]}`;
    return ISO_DATE_RE.test(iso) ? iso : null;
  }
  return null;
}

/** Dizindeki tüm `.bxf` dosyalarını fileCode + scheduleDate + mtime ile listele. */
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
    const scheduleDate = extractScheduleDate(name);
    if (!scheduleDate) continue; // dosya tarihi yoksa group'lanamaz, atla
    const full = path.join(dir, name);
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile()) continue;
      out.push({ path: full, fileCode, scheduleDate, mtime: stat.mtime });
    } catch {
      // Race: dosya enumerasyon sonrası silinmiş olabilir; sessiz atla.
    }
  }
  return out;
}

/**
 * Saf: `(fileCode, scheduleDate)` group'unun en güncel mtime'lı dosyasını
 * döner. Hiç eşleşme yoksa `null`. Eşit mtime'da `path` deterministic
 * tie-break (lexicographic max).
 */
export function pickLatestForFileCodeAndDate(
  files: ReadonlyArray<BxfFileInfo>,
  fileCode: string,
  scheduleDate: string,
): BxfFileInfo | null {
  const normalizedCode = fileCode.trim().toLowerCase();
  let best: BxfFileInfo | null = null;
  for (const f of files) {
    if (f.fileCode !== normalizedCode) continue;
    if (f.scheduleDate !== scheduleDate) continue;
    if (!best) { best = f; continue; }
    if (f.mtime.getTime() > best.mtime.getTime()) {
      best = f;
    } else if (f.mtime.getTime() === best.mtime.getTime() && f.path > best.path) {
      best = f;
    }
  }
  return best;
}

/**
 * Bir kanala (fileCode) ait dizindeki tüm günlerin listesini döner.
 * Initial scan'de "tüm geçmiş günler" sync edilirken kullanılır.
 */
export function listScheduleDatesForFileCode(
  files: ReadonlyArray<BxfFileInfo>,
  fileCode: string,
): string[] {
  const normalized = fileCode.trim().toLowerCase();
  const dates = new Set<string>();
  for (const f of files) {
    if (f.fileCode === normalized) dates.add(f.scheduleDate);
  }
  return Array.from(dates).sort();
}
