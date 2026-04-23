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
  slotCount: number;
}

export type StudioPlanViewMode = 'table' | 'list';

export interface StudioPlanWeekOption {
  label: string;
  value: string;
}
