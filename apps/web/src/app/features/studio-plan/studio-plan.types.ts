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
