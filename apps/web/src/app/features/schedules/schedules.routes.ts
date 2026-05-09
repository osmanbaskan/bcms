import { Routes } from '@angular/router';
import { GROUP } from '@bcms/shared';
import { AuthGuard } from '../../core/guards/auth.guard';

/**
 * SCHED-B5a (Y5-1, ikinci revize 2026-05-08): `/schedules` Canlı Yayın Plan
 * UI'sı olarak korunur (eski görünüm); datasource ScheduleService wrapper
 * üstünden `/api/v1/live-plan`. Mutation route'ları (`new`, `:id`, `:id/edit`)
 * yok — Canlı Yayın Plan B5a'da liste odaklı / read-only. Reporting korunur
 * (Admin-only; datasource schedule canonical, B5b'de canonicalize).
 */
export const schedulesRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./schedule-list/schedule-list.component').then((m) => m.ScheduleListComponent),
  },
  {
    path: 'reporting',
    canActivate: [AuthGuard],
    data: { groups: [GROUP.Admin] },
    loadComponent: () =>
      import('./reporting/schedule-reporting.component').then((m) => m.ScheduleReportingComponent),
  },
];
