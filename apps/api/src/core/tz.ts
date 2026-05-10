/**
 * Timezone helper — canonical: Europe/Istanbul.
 *
 * Bkz. ops/NOTES_FOR_CODEX.md "Timezone Lock" + CLAUDE.md / AGENTS.md.
 *
 * Kural özet:
 * - Tüm operasyonel saatler Türkiye saatidir.
 * - Browser/server/Docker TZ'sine güvenilmez; dönüşümler bu helper üzerinden.
 * - `@db.Timestamptz` UTC instant saklar; render Europe/Istanbul ile yapılır.
 * - `@db.Date / @db.Time` Türkiye-naive business date/time.
 * - `+03:00` literal sadece bu dosyada fallback olarak kullanılabilir.
 */

export const ISTANBUL_TZ = 'Europe/Istanbul';
export const ISTANBUL_OFFSET = '+03:00';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

function assertDate(value: string): void {
  if (!DATE_RE.test(value)) {
    throw new Error(`Geçersiz tarih formatı (YYYY-MM-DD bekleniyor): ${value}`);
  }
}

function assertTime(value: string): void {
  if (!TIME_RE.test(value)) {
    throw new Error(`Geçersiz saat formatı (HH:mm veya HH:mm:ss bekleniyor): ${value}`);
  }
}

/** HH:mm → HH:mm:00, HH:mm:ss → değişmez. */
export function normalizeTime(value: string): string {
  assertTime(value);
  return value.length === 5 ? `${value}:00` : value;
}

/**
 * Türkiye saati input'unu UTC instant'a çevir.
 * Örn: composeIstanbulInstant('2026-06-01', '19:00') → 2026-06-01T16:00:00.000Z
 */
export function composeIstanbulInstant(date: string, time: string): Date {
  assertDate(date);
  const normalized = normalizeTime(time);
  // `+03:00` literal sadece bu helper'ın içinde — Türkiye sabit offset (DST yok).
  return new Date(`${date}T${normalized}${ISTANBUL_OFFSET}`);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function intlPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** UTC instant → Türkiye takvim tarihi "YYYY-MM-DD" (ISO). */
export function formatIstanbulDate(value: Date | string): string {
  const d = toDate(value);
  // en-CA day/month/year zero-padded YYYY-MM-DD üretir.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** UTC instant → Türkiye yerel tarih formatı "DD.MM.YYYY". */
export function formatIstanbulDateTr(value: Date | string): string {
  const d = toDate(value);
  return new Intl.DateTimeFormat('tr-TR', {
    timeZone: ISTANBUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** UTC instant → Türkiye saati "HH:mm" veya "HH:mm:ss". */
export function formatIstanbulTime(value: Date | string, withSeconds = false): string {
  const d = toDate(value);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: ISTANBUL_TZ,
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false,
  }).formatToParts(d);
  const hh = intlPart(parts, 'hour');
  const mm = intlPart(parts, 'minute');
  if (!withSeconds) return `${hh}:${mm}`;
  const ss = intlPart(parts, 'second');
  return `${hh}:${mm}:${ss}`;
}

/** UTC instant → "YYYY-MM-DD HH:mm" Türkiye saati ile birleşik. */
export function formatIstanbulDateTime(value: Date | string, withSeconds = false): string {
  return `${formatIstanbulDate(value)} ${formatIstanbulTime(value, withSeconds)}`;
}

/**
 * Türkiye tarihi için UTC gün aralığı (inclusive sağ uç).
 * gte: o günün Türkiye 00:00:00.000 UTC karşılığı.
 * lte: aynı günün Türkiye 23:59:59.999 UTC karşılığı.
 *
 * Inclusive semantik bilinçli — mevcut backend filtre yolları
 * (`startTime: { lte: to }`, `scheduleDate: { lte: to }`) ile uyumlu.
 * Ertesi gün 00:00 sonucuna dahil EDİLMEZ.
 */
export function istanbulDayRangeUtc(date: string): { gte: Date; lte: Date } {
  assertDate(date);
  const [y, m, d] = date.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
  const nextDayStr = formatIstanbulDate(nextDay);
  const gte = composeIstanbulInstant(date, '00:00:00');
  const halfOpenTo = composeIstanbulInstant(nextDayStr, '00:00:00');
  return {
    gte,
    lte: new Date(halfOpenTo.getTime() - 1),
  };
}

/** Bugünün Türkiye takvim tarihi "YYYY-MM-DD". */
export function istanbulTodayDate(): string {
  return formatIstanbulDate(new Date());
}
