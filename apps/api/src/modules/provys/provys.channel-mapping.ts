import path from 'node:path';
import { PROVYS_CHANNELS, type ProvysChannel, type ProvysChannelSlug } from '@bcms/shared';

/**
 * `.bxf` dosya adından kanal `fileCode`'unu çıkarır. Provys dosya
 * adlandırma sözleşmesi: `<fileCode>-<...>.bxf` (örn. `ltv-2026-05-22.bxf`,
 * `xsnw-feed.bxf`). Sadece base name'in `-` öncesi kısmı kullanılır;
 * uzantı `.bxf` değilse veya base name boşsa `null` döner.
 */
export function extractFileCode(filePath: string): string | null {
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (ext !== '.bxf') return null;
  const stem = base.slice(0, base.length - ext.length);
  if (!stem) return null;
  // Dosya kodu: ilk '-' öncesi (yoksa tüm stem). Lowercase normalize.
  const dashIndex = stem.indexOf('-');
  const code = (dashIndex === -1 ? stem : stem.slice(0, dashIndex)).trim().toLowerCase();
  return code || null;
}

/**
 * `fileCode` → `ProvysChannel`. Bilinmeyen kod `null` döner (worker
 * tarafında "kontrollü log + import yok" davranışı).
 */
export function resolveChannel(fileCode: string | null | undefined): ProvysChannel | null {
  if (!fileCode) return null;
  const normalized = fileCode.trim().toLowerCase();
  return PROVYS_CHANNELS.find((c) => c.fileCode === normalized) ?? null;
}

/**
 * Convenience: dosya yolu → channelSlug.
 */
export function resolveChannelFromPath(filePath: string): ProvysChannelSlug | null {
  const channel = resolveChannel(extractFileCode(filePath));
  return channel?.slug ?? null;
}
