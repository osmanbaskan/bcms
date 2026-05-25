export interface StudioPlanSlot {
  id?: number;
  day: string;
  studio: string;
  time: string;
  startMinute: number;
  program: string;
  color: string;
}

export interface StudioPlan {
  id: number;
  weekStart: string;
  version: number;
  createdBy: string;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
  slots: StudioPlanSlot[];
}

export interface SaveStudioPlanDto {
  slots: StudioPlanSlot[];
}

export interface StudioPlanProgramOption {
  id: number;
  name: string;
  sortOrder: number;
  active: boolean;
}

export interface StudioPlanColorOption {
  id: number;
  label: string;
  value: string;
  sortOrder: number;
  active: boolean;
}

export interface StudioPlanCatalog {
  programs: StudioPlanProgramOption[];
  colors: StudioPlanColorOption[];
}

export interface SaveStudioPlanCatalogDto {
  programs: Array<Pick<StudioPlanProgramOption, 'name' | 'sortOrder' | 'active'>>;
  colors: Array<Pick<StudioPlanColorOption, 'label' | 'value' | 'sortOrder' | 'active'>>;
}

/** 2026-05-25: hafta bazlı time range ayarı.
 *  Persisted=false ise default 07:00-02:00 döner ve plan satırı henüz yoktur. */
export interface StudioPlanSettings {
  weekStart:      string;          // YYYY-MM-DD
  timeRangeStart: string;          // "HH:00"
  timeRangeEnd:   string;          // "HH:00"
  persisted:      boolean;
  updatedBy?:     string | null;
  updatedAt?:     string | null;
}

export interface SaveStudioPlanSettingsDto {
  timeRangeStart: string;          // "HH:00"
  timeRangeEnd:   string;          // "HH:00"
}
