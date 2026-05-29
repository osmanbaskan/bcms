export interface StudioPlanDay {
  id: string;
  label: string;
  date: string;
}

export interface StudioPlanColor {
  label: string;
  value: string;
}

export interface StudioPlanAssignment {
  program: string;
  color: string;
}

export interface StudioPlanListEntry {
  id: string;
  dayLabel: string;
  dayDate: string;
  studio: string;
  startTime: string;
  endTime: string;
  program: string;
  color: string;
  colorLabel: string;
  /** Kapsanan slot adedi (her slot SLOT_MINUTES dakika). */
  slotCount: number;
  /** Operatöre gösterilen toplam dakika; 2026-05-14: 15 dk slot için
   *  hardcoded `slotCount * 30` template kaldırıldı, computed üretilir. */
  durationMinutes: number;
}

export type StudioPlanViewMode = 'table' | 'list';

export interface StudioPlanWeekOption {
  label: string;
  value: string;
}

/** 2026-05-25: Stüdyo Planı hafta seçimi için 3-girişli option listesi
 *  (geçen / bu / gelecek hafta). Ana Stüdyo Planı toolbar select'i ile
 *  Yönetim > Stüdyo Planı Edit ekranı aynı helper'ı kullanır → label/value
 *  hesabı tek yerde. `referenceMonday` yyyy-MM-dd formatında "bu haftanın
 *  Pazartesi"sini bekler; arayan normalize etmiş olarak verir. */
export function buildStudioPlanWeekOptions(referenceMonday: string): StudioPlanWeekOption[] {
  const parsed = parseDateInputValue(referenceMonday);
  const base = parsed ?? new Date();
  const shift = (days: number): Date => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  };
  const toValue = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const toDisplay = (d: Date): string =>
    `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  return [
    { label: `Geçen hafta · ${toDisplay(shift(-7))}`, value: toValue(shift(-7)) },
    { label: `Bu hafta · ${toDisplay(base)}`,         value: toValue(base) },
    { label: `Gelecek hafta · ${toDisplay(shift(7))}`, value: toValue(shift(7)) },
  ];
}

function parseDateInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** 2026-05-25: hafta bazlı time range → 15 dk slot string array.
 *  Kurallar:
 *   - startStr === endStr  → 24 saat (96 slot)
 *   - endStr > startStr    → linear (endMin - startMin) / 15
 *   - endStr < startStr    → gece sarması: (24*60 - startMin) + endMin
 *  startStr/endStr "HH:00" saatlik formatta beklenir; ama 15dk slot üretilir.
 */
export function buildSlotsForRange(
  startStr: string,
  endStr: string,
  slotMinutes: number,
): string[] {
  const toMin = (s: string): number | null => {
    if (!/^\d{2}:\d{2}$/.test(s)) return null;
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  };
  const s = toMin(startStr);
  const e = toMin(endStr);
  if (s === null || e === null) return [];
  const total = s === e ? 24 * 60 : (e > s ? e - s : (24 * 60 - s) + e);
  const slots: string[] = [];
  for (let i = 0; i < Math.floor(total / slotMinutes); i++) {
    const minute = (s + i * slotMinutes) % (24 * 60);
    const h = Math.floor(minute / 60);
    const mm = minute % 60;
    slots.push(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
  }
  return slots;
}
