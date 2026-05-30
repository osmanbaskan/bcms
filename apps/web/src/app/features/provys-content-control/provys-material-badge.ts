/**
 * Provys "Materyal" kolonu — status -> compact label + tone + tooltip mapping.
 * Saf fonksiyonlar; Angular bağımlılığı yok.
 *
 * Tone kategorileri (CSS class fragment ile birebir):
 *  - neutral : live_not_applicable, dc_not_applicable (her ikisi de SSDB kapsami disi)
 *  - muted   : unchecked
 *  - found   : found_match            (VAR → #00a6d6 cyan)
 *  - danger  : missing_material (EKSİK → kırmızı), ssdb_error
 *  - warning : found_duration_mismatch (SÜRE UYMUYOR → sarı), found_duration_unknown
 *  (2026-05-30 kullanıcı tercihi: var=cyan, eksik=kırmızı, süre uymuyor=sarı.)
 *
 * Provys/BXF süresi UI'nın "Süre" hücresinde mevcut (formatDur). SSDB süresi
 * SADECE bu badge'in tooltip'inde gösterilir; "Süre" hücresi ezilmez.
 */

import type {
  ProvysItemDto,
  ProvysItemSsdbInfo,
  ProvysMaterialStatus,
  SsdbMatchMethod,
} from './provys.types';

export type MaterialBadgeTone = 'neutral' | 'muted' | 'warning' | 'success' | 'danger' | 'found';

export interface MaterialBadgeStyle {
  /** Kompakt etiket; hücrede tek satır taşmasın diye kısa tutulmuştur. */
  compact: string;
  tone: MaterialBadgeTone;
}

export const MATERIAL_BADGE: Record<ProvysMaterialStatus, MaterialBadgeStyle> = {
  live_not_applicable:     { compact: 'Canlı',        tone: 'neutral' },
  // SSDB kapsami disi — alarm degil; kompakt notr em-dash, tooltip aciklayici.
  dc_not_applicable:       { compact: '—',            tone: 'neutral' },
  unchecked:               { compact: 'Bekliyor',     tone: 'muted' },
  missing_material:        { compact: 'Eksik',        tone: 'danger' },
  found_match:             { compact: 'Var',          tone: 'found' },
  found_duration_mismatch: { compact: 'Süre uymuyor', tone: 'warning' },
  found_duration_unknown:  { compact: 'Süre yok',     tone: 'warning' },
  ssdb_error:              { compact: 'SSDB hata',    tone: 'danger' },
};

/**
 * "Sadece eksik materyaller" filtresinde gösterilecek status'ler.
 * CANLI (`live_not_applicable`), DC yok (`dc_not_applicable`) ve henüz
 * bilinmeyen (`unchecked`) ve bilinen-OK (`found_match`) HARİÇ.
 * Her iki "not_applicable" status SSDB kapsamı dışı; alarm değildir.
 */
export const MISSING_MATERIAL_STATUSES: ReadonlySet<ProvysMaterialStatus> = new Set<ProvysMaterialStatus>([
  'missing_material',
  'found_duration_mismatch',
  'found_duration_unknown',
  'ssdb_error',
]);

export function isMaterialMissing(item: ProvysItemDto): boolean {
  return MISSING_MATERIAL_STATUSES.has(item.ssdb.materialStatus);
}

const MATCH_METHOD_LABEL: Record<SsdbMatchMethod, string> = {
  alias: 'alias',
  original_filename: 'original_filename',
  name_like: 'name_like',
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Frame sayısını HH:MM:SS:FF olarak göster (integer fps). Display amaçlı; null-tolerant. */
function framesToSmpteDisplay(frames: number | null, fps: number | null): string | null {
  if (frames == null || !Number.isFinite(frames) || frames < 0) return null;
  if (fps == null || !Number.isFinite(fps) || fps <= 0) return null;
  const hh = Math.floor(frames / (3600 * fps));
  const rem1 = frames - hh * 3600 * fps;
  const mm = Math.floor(rem1 / (60 * fps));
  const rem2 = rem1 - mm * 60 * fps;
  const ss = Math.floor(rem2 / fps);
  const ff = rem2 - ss * fps;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function formatLastChecked(iso: string | null): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

function fmtMatch(method: SsdbMatchMethod | null): string {
  return method ? (MATCH_METHOD_LABEL[method] ?? method) : '—';
}

/**
 * Status'a göre multi-line tooltip metni. Browser `title` attribute'a verilir;
 * yeni satır `\n` ile çıkar.
 */
export function buildMaterialTooltip(item: ProvysItemDto): string {
  const s: ProvysItemSsdbInfo = item.ssdb;
  switch (s.materialStatus) {
    case 'live_not_applicable':
      return 'Canlı yayın; SSDB MAM materyal kontrolü yapılmaz';

    case 'dc_not_applicable':
      return 'DC kod yok; SSDB MAM materyal kontrolü yapılmaz';

    case 'unchecked':
      return 'Kontrol bekliyor (cache henüz yok veya TTL henüz dolmamış)';

    case 'missing_material': {
      const lines = [
        'Materyal eksik',
        item.dcCode ? `DC: ${item.dcCode}` : null,
        `Son kontrol: ${formatLastChecked(s.lastCheckedAt)}`,
      ].filter((l): l is string => l != null);
      return lines.join('\n');
    }

    case 'found_match': {
      const fps = s.frameRate;
      const ssdbTc = s.ssdbDurationTimecode ?? framesToSmpteDisplay(s.ssdbDurationFrames, fps);
      const lines = [
        'Materyal var',
        ssdbTc != null ? `MAM süre: ${ssdbTc}` : null,
        `Yöntem: ${fmtMatch(s.matchMethod)}`,
        s.mediaGuid ? `MAM ID: ${s.mediaGuid}` : null,
        `Son kontrol: ${formatLastChecked(s.lastCheckedAt)}`,
      ].filter((l): l is string => l != null);
      return lines.join('\n');
    }

    case 'found_duration_mismatch': {
      const fps = s.frameRate;
      const provysTc = framesToSmpteDisplay(s.provysDurationFrames, fps) ?? item.durationTimecode ?? '—';
      const ssdbTc = s.ssdbDurationTimecode ?? framesToSmpteDisplay(s.ssdbDurationFrames, fps) ?? '—';
      const diff = (s.provysDurationFrames != null && s.ssdbDurationFrames != null)
        ? Math.abs(s.provysDurationFrames - s.ssdbDurationFrames) : null;
      const provysFrames = s.provysDurationFrames;
      const ssdbFrames = s.ssdbDurationFrames;
      const lines = [
        'Materyal var, duration uymuyor',
        `Provys: ${provysTc}${provysFrames != null ? ` (${provysFrames} frame)` : ''}`,
        `SSDB: ${ssdbTc}${ssdbFrames != null ? ` (${ssdbFrames} frame)` : ''}`,
        diff != null ? `Fark: ${diff} frame` : null,
        `Yöntem: ${fmtMatch(s.matchMethod)}`,
        s.mediaGuid ? `MAM ID: ${s.mediaGuid}` : null,
        `Son kontrol: ${formatLastChecked(s.lastCheckedAt)}`,
      ].filter((l): l is string => l != null);
      return lines.join('\n');
    }

    case 'found_duration_unknown': {
      const lines = [
        'Materyal var, süre yok',
        `Yöntem: ${fmtMatch(s.matchMethod)}`,
        s.mediaGuid ? `MAM ID: ${s.mediaGuid}` : null,
        `Son kontrol: ${formatLastChecked(s.lastCheckedAt)}`,
      ].filter((l): l is string => l != null);
      return lines.join('\n');
    }

    case 'ssdb_error': {
      const lines = [
        'SSDB hata',
        s.lastError ? `Hata: ${truncate(s.lastError, 160)}` : null,
        `Son kontrol: ${formatLastChecked(s.lastCheckedAt)}`,
      ].filter((l): l is string => l != null);
      return lines.join('\n');
    }
  }
}
