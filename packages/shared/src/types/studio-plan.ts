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
