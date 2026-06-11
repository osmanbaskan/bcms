import path from 'node:path';
import { extractFileCode } from './provys.channel-mapping.js';
import { LocalDirSource, type BxfSource } from '../../lib/bxf-source.js';

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
 * Dosya adı format sözleşmesi (2026-06-11'de aralık desteği eklendi):
 *   1) Tek gün : `BXF_Playlist_<CODE>_<YYYYMMDD>_...bxf` → {from: D, to: D}
 *   2) Aralık  : `BXF_Playlist_<CODE>_<YYYYMMDD>0000_<YYYYMMDD>0000_...bxf`
 *      → {from, to} (uçlar DAHİL). Kural (Osman): tarih token'ı 8 haneden
 *      uzunsa ve KUYRUK tamamen sıfırsa (saat 0000) 8 hane gibi davran;
 *      kuyruk ≠ 0000 ise reddet (muhafazakâr — belirsiz formata kapı yok).
 *   3) Legacy  : `<code>-YYYY-MM-DD.bxf` → tek gün.
 * Aralık tavanı 31 gün (bozuk ada karşı koruma) — aşarsa null.
 * NOT: Ad-aralığı yalnız ADAYLIK içindir; event'in hangi güne ait olduğu
 * parser'daki per-event broadcastDate ile belirlenir (içerik kanonik).
 */

export interface BxfDateRange {
  /** Kapsanan ilk yayın günü `YYYY-MM-DD` (dahil). */
  from: string;
  /** Kapsanan son yayın günü `YYYY-MM-DD` (dahil). Tek-gün dosyada from'a eşit. */
  to: string;
}

export interface BxfFileInfo {
  /** İnsan-okur tam yol (local: fs yolu; smb: smb://.../ad) — sourceFile/log için. */
  path: string;
  /** Kaynak içindeki çıplak dosya adı — source.read(name) ile okunur. */
  name: string;
  fileCode: string;
  /** Dosyanın ad-aralığı (tek-gün dosyada from === to). */
  dateFrom: string;
  dateTo: string;
  mtime: Date;
  /** İçerik LRU anahtarı için (SMB'de yeniden-okumayı önler). */
  size?: number;
}

const FILENAME_RANGE_RE = /^BXF_Playlist_[A-Za-z0-9]+_(\d{4})(\d{2})(\d{2})0000_(\d{4})(\d{2})(\d{2})0000_/i;
const FILENAME_DATE_RE  = /^BXF_Playlist_[A-Za-z0-9]+_(\d{4})(\d{2})(\d{2})_/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Aralık tavanı (gün, uçlar dahil) — bozuk/yanlış ada karşı koruma. */
export const MAX_RANGE_DAYS = 31;

function isoOrNull(y: string, m: string, d: string): string | null {
  const iso = `${y}-${m}-${d}`;
  return ISO_DATE_RE.test(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? iso : null;
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/**
 * Dosya adından kapsanan gün aralığını çıkarır. Eşleşme yoksa, aralık
 * tersse (to<from) ya da tavanı (31 gün) aşıyorsa null.
 */
export function extractScheduleRange(filePath: string): BxfDateRange | null {
  const base = path.basename(filePath);
  // 1) Aralık: _YYYYMMDD0000_YYYYMMDD0000_ (kuyruk-sıfır kuralı regex'te gömülü)
  const mr = base.match(FILENAME_RANGE_RE);
  if (mr) {
    const from = isoOrNull(mr[1], mr[2], mr[3]);
    const to = isoOrNull(mr[4], mr[5], mr[6]);
    if (!from || !to) return null;
    const span = daysBetween(from, to);
    if (span < 0 || span + 1 > MAX_RANGE_DAYS) return null; // ters ya da tavan aşımı
    return { from, to };
  }
  // 2) Tek gün: _YYYYMMDD_
  const m1 = base.match(FILENAME_DATE_RE);
  if (m1) {
    const iso = isoOrNull(m1[1], m1[2], m1[3]);
    return iso ? { from: iso, to: iso } : null;
  }
  // 3) Legacy: <code>-YYYY-MM-DD.bxf
  const m2 = base.match(/^[A-Za-z0-9]+-(\d{4})-(\d{2})-(\d{2})/);
  if (m2) {
    const iso = isoOrNull(m2[1], m2[2], m2[3]);
    return iso ? { from: iso, to: iso } : null;
  }
  return null;
}

/** Geriye-uyum: aralığın İLK gününü döner (eski tek-gün sözleşmesi). */
export function extractScheduleDate(filePath: string): string | null {
  return extractScheduleRange(filePath)?.from ?? null;
}

/**
 * Kaynaktaki (local dizin VEYA smb) tüm `.bxf` dosyalarını fileCode +
 * tarih-aralığı + mtime ile listele. list() HATASI yukarı fırlar — caller
 * (poller/sync) yarım liste üzerinden karar VERMEMELİ.
 */
export async function listBxfFilesFromSource(source: BxfSource): Promise<BxfFileInfo[]> {
  const entries = await source.list();
  const base = source.kind === 'smb' ? `${source.describe()}/` : '';
  const out: BxfFileInfo[] = [];
  for (const e of entries) {
    if (path.extname(e.name).toLowerCase() !== '.bxf') continue;
    const fileCode = extractFileCode(e.name);
    if (!fileCode) continue;
    const range = extractScheduleRange(e.name);
    if (!range) continue; // dosya tarihi/aralığı yoksa group'lanamaz, atla
    out.push({
      path: base ? base + e.name : e.name,
      name: e.name,
      fileCode,
      dateFrom: range.from,
      dateTo: range.to,
      mtime: e.mtime,
      size: e.size,
    });
  }
  return out;
}

/** Geri-uyum: yerel dizin yolu ile listeleme (testler + mevcut çağrılar). */
export async function listBxfFiles(dir: string): Promise<BxfFileInfo[]> {
  let files: BxfFileInfo[];
  try {
    files = await listBxfFilesFromSource(new LocalDirSource(dir));
  } catch {
    return [];
  }
  // Local'de path tam fs yolu olmalı (sourceFile sözleşmesi).
  return files.map((f) => ({ ...f, path: path.join(dir, f.name) }));
}

/** Dosyanın ad-aralığı verilen günü kapsıyor mu (uçlar dahil; ISO string karşılaştırma). */
export function fileCoversDate(f: Pick<BxfFileInfo, 'dateFrom' | 'dateTo'>, scheduleDate: string): boolean {
  return f.dateFrom <= scheduleDate && scheduleDate <= f.dateTo;
}

/**
 * Saf: verilen günü KAPSAYAN (fileCode eşli) dosyalardan en güncel mtime'lıyı
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
    if (!fileCoversDate(f, scheduleDate)) continue;
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
 * Bir kanala (fileCode) ait dizindeki tüm günlerin listesini döner —
 * aralıklı dosyalar kapsadıkları HER günü ekler (tavan 31 gün garantili).
 * Initial scan'de "tüm geçmiş günler" sync edilirken kullanılır.
 */
export function listScheduleDatesForFileCode(
  files: ReadonlyArray<BxfFileInfo>,
  fileCode: string,
): string[] {
  const normalized = fileCode.trim().toLowerCase();
  const dates = new Set<string>();
  for (const f of files) {
    if (f.fileCode !== normalized) continue;
    let d = f.dateFrom;
    while (d <= f.dateTo) {
      dates.add(d);
      const nd = new Date(`${d}T00:00:00Z`);
      nd.setUTCDate(nd.getUTCDate() + 1);
      d = nd.toISOString().slice(0, 10);
    }
  }
  return Array.from(dates).sort();
}
