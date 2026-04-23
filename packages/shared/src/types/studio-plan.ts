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
