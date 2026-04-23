import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import type { SaveStudioPlanDto, StudioPlan } from '@bcms/shared';

@Injectable({ providedIn: 'root' })
export class StudioPlanService {
  constructor(private api: ApiService) {}

  getPlan(weekStart: string): Observable<StudioPlan> {
    return this.api.get<StudioPlan>(`/studio-plans/${weekStart}`);
  }

  savePlan(weekStart: string, dto: SaveStudioPlanDto): Observable<StudioPlan> {
    return this.api.put<StudioPlan>(`/studio-plans/${weekStart}`, dto);
  }
}
