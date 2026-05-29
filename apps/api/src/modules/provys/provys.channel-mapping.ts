import path from 'node:path';
import { PROVYS_CHANNELS, type ProvysChannel, type ProvysChannelSlug } from '@bcms/shared';

/**
 * `.bxf` dosya adından kanal `fileCode`'unu çıkarır. Provys iki adlandırma
 * sözleşmesi üretebiliyor:
 *
 *   1) `<code>-<...>.bxf` — kısa form (örn. `ltv-2026-05-22.bxf`,
 *      `xsnw-feed.bxf`).
 *   2) `BXF_Playlist_<CODE>_<...>.bxf` — Provys playout exporter standart
 *      adlandırması (örn. `BXF_Playlist_LT2_20260217_20260217_20260216_195715_caf.bxf`).
 *
 * İki form da case-insensitive okunur ve **lowercase** normalize edilir
 * (`LT2` → `lt2`). `.bxf` uzantısı yoksa veya hiçbir desen eşleşmezse `null`.
 */
const PLAYLIST_PREFIX_RE = /^BXF_Playlist_([A-Za-z0-9]+)_/i;
const DASH_PREFIX_RE     = /^([A-Za-z0-9]+)(?:-|$)/;

export function extractFileCode(filePath: string): string | null {
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (ext !== '.bxf') return null;
  const stem = base.slice(0, base.length - ext.length);
  if (!stem) return null;

  // 1) Provys playlist exporter: BXF_Playlist_<CODE>_...
  const playlistMatch = stem.match(PLAYLIST_PREFIX_RE);
  if (playlistMatch) {
    return playlistMatch[1].trim().toLowerCase() || null;
  }

  // 2) Kısa form: <code>-<...> (veya sadece <code>).
  const dashMatch = stem.match(DASH_PREFIX_RE);
  if (dashMatch) {
    return dashMatch[1].trim().toLowerCase() || null;
  }

  return null;
}

/**
 * `fileCode` → `ProvysChannel`. Bilinmeyen kod `null` döner (worker
 * tarafında "kontrollü log + import yok" davranışı).
 *
 * Lookup hem canonical `fileCode` hem de `fileCodeAliases` üzerinden çalışır;
 * alias görüldüğünde aynı canonical channel objesi döner. UI/DB downstream
 * `channel.slug` üzerinden ayrıştığı için alias farkı görünmez.
 */
export function resolveChannel(fileCode: string | null | undefined): ProvysChannel | null {
  if (!fileCode) return null;
  const normalized = fileCode.trim().toLowerCase();
  return (
    PROVYS_CHANNELS.find(
      (c) =>
        c.fileCode === normalized ||
        c.fileCodeAliases?.includes(normalized) === true,
    ) ?? null
  );
}

/**
 * Convenience: dosya yolu → channelSlug.
 */
export function resolveChannelFromPath(filePath: string): ProvysChannelSlug | null {
  const channel = resolveChannel(extractFileCode(filePath));
  return channel?.slug ?? null;
}
