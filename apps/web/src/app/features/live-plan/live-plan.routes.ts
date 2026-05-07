import { Routes } from '@angular/router';

/**
 * Madde 5 M5-B10a — Live-plan feature routes.
 *
 * Y1 lock: yeni `/live-plan` (liste) + `/live-plan/:entryId` (detay) route.
 * Mevcut `/schedules` schedule-list ekranı dokunulmaz; paralel ekran.
 */
export const livePlanRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./live-plan-list/live-plan-list.component').then((m) => m.LivePlanListComponent),
  },
  {
    path: ':entryId',
    loadComponent: () =>
      import('./live-plan-detail/live-plan-detail.component').then((m) => m.LivePlanDetailComponent),
  },
];
