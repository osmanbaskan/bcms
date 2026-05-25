// Stüdyo Planı Edit — types + helpers.

export interface ProgramRow {
  id?: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface ColorRow {
  id?: number;
  label: string;
  value: string;        // #RRGGBB
  sortOrder: number;
  active: boolean;
}

export interface CatalogDto {
  programs: Array<{ id: number; name: string; sortOrder: number; active: boolean }>;
  colors:   Array<{ id: number; label: string; value: string; sortOrder: number; active: boolean }>;
}

export interface SettingsDto {
  weekStart:      string;
  timeRangeStart: string;
  timeRangeEnd:   string;
  persisted:      boolean;
  updatedBy?:     string | null;
  updatedAt?:     string | null;
}

/** Verilen tarihin ait olduğu haftanın Pazartesi'sini (YYYY-MM-DD) döner. */
export function mondayOf(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export interface TimeOption {
  value: string;        // "HH:00"
  label: string;
}

export const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const HHMM_RE = /^\d{2}:\d{2}$/;

/** Saatlik option listesi: "00:00", "01:00", ..., "23:00" (24 adet). */
export function buildHourlyTimeOptions(): TimeOption[] {
  const out: TimeOption[] = [];
  for (let h = 0; h < 24; h++) {
    const v = `${String(h).padStart(2, '0')}:00`;
    out.push({ value: v, label: v });
  }
  return out;
}

/** "HH:MM" → linear dakika (0..). Domain wrap YOK; saatlik form için. */
export function parseHHMMFlat(value: string): number | null {
  if (!HHMM_RE.test(value)) return null;
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

export interface CatalogValidationError {
  kind: 'program' | 'color' | 'time' | 'count';
  index?: number;
  message: string;
}

export function validatePrograms(programs: ProgramRow[]): CatalogValidationError[] {
  const errs: CatalogValidationError[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i];
    const trimmed = (p.name ?? '').trim();
    if (!trimmed) {
      errs.push({ kind: 'program', index: i, message: `Program ${i + 1}: ad boş olamaz` });
    } else if (trimmed.length > 200) {
      errs.push({ kind: 'program', index: i, message: `Program ${i + 1}: ad 200 karakteri aşıyor` });
    } else if (seen.has(trimmed)) {
      errs.push({ kind: 'program', index: i, message: `Program ${i + 1}: "${trimmed}" zaten var (mükerrer)` });
    } else {
      seen.add(trimmed);
    }
  }
  if (programs.length > 200) {
    errs.push({ kind: 'count', message: `Program sayısı 200'ü aşıyor (mevcut ${programs.length})` });
  }
  return errs;
}

export function validateColors(colors: ColorRow[]): CatalogValidationError[] {
  const errs: CatalogValidationError[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    const trimmed = (c.label ?? '').trim();
    if (!trimmed) {
      errs.push({ kind: 'color', index: i, message: `Renk ${i + 1}: ad boş olamaz` });
    } else if (trimmed.length > 100) {
      errs.push({ kind: 'color', index: i, message: `Renk ${i + 1}: ad 100 karakteri aşıyor` });
    } else if (seen.has(trimmed)) {
      errs.push({ kind: 'color', index: i, message: `Renk ${i + 1}: "${trimmed}" zaten var (mükerrer)` });
    } else {
      seen.add(trimmed);
    }
    if (!HEX_RE.test(c.value ?? '')) {
      errs.push({ kind: 'color', index: i, message: `Renk ${i + 1}: hex değer geçersiz (#RRGGBB)` });
    }
  }
  if (colors.length > 100) {
    errs.push({ kind: 'count', message: `Renk sayısı 100'ü aşıyor (mevcut ${colors.length})` });
  }
  return errs;
}

/** Saatlik zaman aralığı validation:
 *   - boş değil
 *   - HH:MM format (regex)
 *   - dakika === 0 (saatlik grid)
 *   - 0 ≤ saat ≤ 23
 *   - start === end → 24 saat (geçerli, gece sarması özel kuralı)
 *   - start !== end → gece sarması (e > s) veya aynı gün — herhangi kombo geçerli
 */
export function validateTimeRange(
  selectedStart: string,
  selectedEnd: string,
): CatalogValidationError[] {
  const errs: CatalogValidationError[] = [];
  if (!selectedStart) errs.push({ kind: 'time', message: 'Başlangıç saati seçilmeli' });
  if (!selectedEnd)   errs.push({ kind: 'time', message: 'Bitiş saati seçilmeli' });
  if (!selectedStart || !selectedEnd) return errs;

  const s = parseHHMMFlat(selectedStart);
  const e = parseHHMMFlat(selectedEnd);
  if (s === null) errs.push({ kind: 'time', message: 'Başlangıç format geçersiz (HH:MM)' });
  if (e === null) errs.push({ kind: 'time', message: 'Bitiş format geçersiz (HH:MM)' });
  if (s === null || e === null) return errs;

  if (s % 60 !== 0) errs.push({ kind: 'time', message: 'Başlangıç saatlik olmalı (dk = 00)' });
  if (e % 60 !== 0) errs.push({ kind: 'time', message: 'Bitiş saatlik olmalı (dk = 00)' });

  const sh = Math.floor(s / 60);
  const eh = Math.floor(e / 60);
  if (sh < 0 || sh > 23) errs.push({ kind: 'time', message: 'Başlangıç 00-23 aralığında olmalı' });
  if (eh < 0 || eh > 23) errs.push({ kind: 'time', message: 'Bitiş 00-23 aralığında olmalı' });

  // start === end özel kural: 24 saat — hata değil, valid.
  return errs;
}

/** Saatlik aralık süresi (dakika):
 *   - start === end → 1440 (24 saat — özel kural)
 *   - end > start → end - start
 *   - end < start → gece sarması: (24*60 - start) + end
 */
export function durationMinutes(selectedStart: string, selectedEnd: string): number | null {
  const s = parseHHMMFlat(selectedStart);
  const e = parseHHMMFlat(selectedEnd);
  if (s === null || e === null) return null;
  if (s === e) return 24 * 60;
  if (e > s) return e - s;
  return (24 * 60 - s) + e;
}
