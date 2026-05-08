import { Routes } from '@angular/router';
import { GROUP } from '@bcms/shared';
import { AuthGuard } from '../../core/guards/auth.guard';

/**
 * SCHED-B5a (2026-05-08): Eski schedule-list/form/detail bileşenleri silindi.
 * Kalan kapsam:
 *   - root path `/schedules` → `/yayin-planlama` redirect (Y5-1)
 *   - `/schedules/reporting` korunur (Admin-only; canonical refactor B5a backend
 *     /reports/live-plan*; UI redesign B5 dışı follow-up)
 */
export const schedulesRoutes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: '/yayin-planlama',
  },
  {
    path: 'reporting',
    canActivate: [AuthGuard],
    data: { groups: [GROUP.Admin] },
    loadComponent: () =>
      import('./reporting/schedule-reporting.component').then((m) => m.ScheduleReportingComponent),
  },
];
