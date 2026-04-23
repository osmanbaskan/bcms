import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import type { SaveStudioPlanCatalogDto, SaveStudioPlanDto, StudioPlan, StudioPlanCatalog } from '@bcms/shared';

@Injectable({ providedIn: 'root' })
export class StudioPlanService {
  constructor(private api: ApiService) {}

  getPlan(weekStart: string): Observable<StudioPlan> {
    return this.api.get<StudioPlan>(`/studio-plans/${weekStart}`);
  }

  savePlan(weekStart: string, dto: SaveStudioPlanDto): Observable<StudioPlan> {
    return this.api.put<StudioPlan>(`/studio-plans/${weekStart}`, dto);
  }

  getCatalog(): Observable<StudioPlanCatalog> {
    return this.api.get<StudioPlanCatalog>('/studio-plans/catalog');
  }

  saveCatalog(dto: SaveStudioPlanCatalogDto): Observable<StudioPlanCatalog> {
    return this.api.put<StudioPlanCatalog>('/studio-plans/catalog', dto);
  }
}
