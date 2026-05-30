import path from 'node:path';
import type { AsrunChannelSlug } from '@bcms/shared';

/**
 * Asrun BXF filename çözümleyici. Provys'in `BXF_Playlist_<CODE>_...`
 * exporter sözleşmesinden farklı: Asrun Outbox/Ok dizini playout sonrası
 * üretildiği için NEXIO playout otomasyonu naming convention kullanılır.
 *
 * Gerçek örnekler (2026-05-23 audit):
 *   beIN SPORTS 1 HD_NEXIO33-P1_20260522_000000.bxf
 *   beIN SPORTS 1 HD_MP_NEXIO33-P1_20260522_000000.bxf
 *   beIN SPORTS 2 HD_NEXIO33-P4_20260402_000000.bxf
 *   beIN SPORTS 3 HD_NEXIO36-P4_20260522_000000.bxf
 *   beIN SPORTS 3 HD_NEXIO33-P3_20260504_000000 - Copy.bxf   (Windows kopya)
 *   beIN SPORTS 4 HD_NEXIO-PLAYER 45_20260522_000000.bxf
 *   beIN SPORTS 5 HD_Nexio33-P2_20260522_000000.bxf
 *   beIN SPORTS 5 HD_Nexio33-P2_20260501_000000_ok.bxf       (extra `_ok` suffix)
 *   beIN SPORTS HABER HD_MP_NEXIO33-P2_20260529_000000.bxf   (haber → beinhaber)
 *
 * Kontrat:
 *   - Kanal prefix dosya adının başında: `beIN SPORTS 1..5`, `beIN SPORTS HABER`
 *     (haber kanalı — Outbox/Ok'taki gerçek playout ismi, 2026-05-30), veya eski/
 *     alternatif `beIN HABER` / `beIN NEWS`. Üçü de → beinhaber.
 *   - Tarih + saat suffix `_YYYYMMDD_HHMMSS` desenli; dosya adının
 *     herhangi bir yerinde olabilir (sonunda `.bxf` zorunlu, arada extra
 *     suffix `_ok` / ` - Copy` kabul edilir).
 *   - NEXIO/MP/Player/P-number kısımları ÖNEMSİZ — kanal sadece prefix'ten
 *     belirlenir.
 *   - Eşleşme yoksa `null` (watcher uyarı log'lar, sessiz skip).
 */

// "SPORTS HABER" alternatifi "SPORTS [1-5]"den ÖNCE — rakamla çakışmaz ama
// niyet net: beIN SPORTS HABER HD → beinhaber (sports kanalı değil).
const CHANNEL_PREFIX_RE = /^beIN (SPORTS HABER|SPORTS [1-5]|HABER|NEWS)\b/i;
const DATETIME_RE = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:[^/]*)?\.bxf$/i;

export interface ParsedAsrunFilename {
  channelSlug: AsrunChannelSlug;
  /** Yayın günü `YYYY-MM-DD` (filename'den; per-event broadcastDate parser
   *  çıktısında ayrıca taşınır ve service tarafında canonical kabul edilir). */
  scheduleDate: string;
  /** Dosya adındaki ham tarih `YYYYMMDD`. */
  fileDate: string;
  /** Dosya adındaki ham saat `HHMMSS`. */
  fileTime: string;
}

function channelSlugFromMatch(part: string): AsrunChannelSlug | null {
  const upper = part.toUpperCase();
  if (upper === 'SPORTS 1') return 'beinsports1';
  if (upper === 'SPORTS 2') return 'beinsports2';
  if (upper === 'SPORTS 3') return 'beinsports3';
  if (upper === 'SPORTS 4') return 'beinsports4';
  if (upper === 'SPORTS 5') return 'beinsports5';
  if (upper === 'SPORTS HABER' || upper === 'HABER' || upper === 'NEWS') return 'beinhaber';
  return null;
}

export function parseAsrunFilename(filePath: string): ParsedAsrunFilename | null {
  const base = path.basename(filePath);
  if (!/\.bxf$/i.test(base)) return null;

  const ch = base.match(CHANNEL_PREFIX_RE);
  if (!ch) return null;
  const channelSlug = channelSlugFromMatch(ch[1]);
  if (!channelSlug) return null;

  const dt = base.match(DATETIME_RE);
  if (!dt) return null;
  const [, yyyy, mm, dd, hh, mi, ss] = dt;

  // Basit tarih sanity (ay 01-12, gün 01-31)
  const m = Number(mm);
  const d = Number(dd);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return {
    channelSlug,
    scheduleDate: `${yyyy}-${mm}-${dd}`,
    fileDate: `${yyyy}${mm}${dd}`,
    fileTime: `${hh}${mi}${ss}`,
  };
}
