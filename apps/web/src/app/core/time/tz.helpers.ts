/**
 * Frontend timezone helper — canonical: Europe/Istanbul.
 *
 * Bkz. ops/NOTES_FOR_CODEX.md "Timezone Lock" + CLAUDE.md / AGENTS.md.
 *
 * Kurallar:
 * - Tüm operasyonel saatler Türkiye saati.
 * - Browser TZ'sine güvenilmez; dönüşümler bu helper üzerinden.
 * - `T${time}.000Z` ile kullanıcı saatini UTC sayan compose yasak;
 *   kullanıcı saatini composeIstanbulInstant ile UTC instant'a çevir.
 * - `toLocaleString / toLocaleDateString / toLocaleTimeString` veya
 *   `Intl.DateTimeFormat` timezone parametresiz **kullanılmaz** — yerlerine
 *   buradaki formatIstanbul* helper'ları kullanılır.
 * - `+03:00` literal yalnız bu dosyada fallback olarak yer alabilir.
 */

export const ISTANBUL_TZ = 'Europe/Istanbul';
export const ISTANBUL_OFFSET = '+03:00';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

function assertDate(value: string): void {
  if (!DATE_RE.test(value)) {
    throw new Error(`Geçersiz tarih (YYYY-MM-DD bekleniyor): ${value}`);
  }
}

function assertTime(value: string): void {
  if (!TIME_RE.test(value)) {
    throw new Error(`Geçersiz saat (HH:mm veya HH:mm:ss bekleniyor): ${value}`);
  }
}

export function normalizeTime(value: string): string {
  assertTime(value);
  return value.length === 5 ? `${value}:00` : value;
}

/** Türkiye saati input → UTC instant Date. */
export function composeIstanbulInstant(date: string, time: string): Date {
  assertDate(date);
  const normalized = normalizeTime(time);
  return new Date(`${date}T${normalized}${ISTANBUL_OFFSET}`);
}

/** Türkiye saati input → UTC ISO string. */
export function composeIstanbulIso(date: string, time: string): string {
  return composeIstanbulInstant(date, time).toISOString();
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function intlPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** UTC instant → Türkiye tarihi "YYYY-MM-DD" (ISO). */
export function formatIstanbulDate(value: Date | string): string {
  const d = toDate(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISTANBUL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** UTC instant → Türkiye tarihi "DD.MM.YYYY" (yerel görüntü). */
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

/** UTC instant → "YYYY-MM-DD HH:mm" Türkiye saatiyle. */
export function formatIstanbulDateTime(value: Date | string, withSeconds = false): string {
  return `${formatIstanbulDate(value)} ${formatIstanbulTime(value, withSeconds)}`;
}

/**
 * Türkiye günü için UTC range — API range filter gönderimi.
 * - from: Türkiye 00:00:00.000 UTC karşılığı.
 * - to:   Türkiye 23:59:59.999 UTC karşılığı (inclusive sağ uç).
 *
 * Inclusive semantik bilinçli: backend filtreleri (`startTime: { lte: to }`,
 * `scheduleDate: { lte: to }`) ile uyumludur. Ertesi gün 00:00 sonucuna
 * DAHİL EDİLMEZ.
 */
export function istanbulDayRangeUtc(date: string): { from: string; to: string } {
  assertDate(date);
  const [y, m, d] = date.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
  const nextDayStr = formatIstanbulDate(nextDay);
  const fromDate = composeIstanbulInstant(date, '00:00:00');
  const halfOpenTo = composeIstanbulInstant(nextDayStr, '00:00:00');
  const toDate = new Date(halfOpenTo.getTime() - 1);
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

/** Bugünün Türkiye takvim tarihi "YYYY-MM-DD". */
export function istanbulTodayDate(): string {
  return formatIstanbulDate(new Date());
}

/** Browser local Date → Türkiye "YYYY-MM-DD" (datepicker output). */
export function dateOnlyToIstanbul(value: Date): string {
  // Datepicker browser local Date verir; gün/ay/yıl componentleri local'dir.
  // Türkiye gün karşılığı için local componentleri "naive Türkiye gün" sayıyoruz —
  // operatör browser TZ'si Türkiye değilse bile UI takvim seçimi doğru gün için
  // tıklanmış olur (datepicker visual layer).
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
