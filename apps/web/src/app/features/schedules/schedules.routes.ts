import { Routes } from '@angular/router';
import { AuthGuard } from '../../core/guards/auth.guard';

export const schedulesRoutes: Routes = [
  {
    path: '',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./schedule-list/schedule-list.component').then((m) => m.ScheduleListComponent),
  },
  {
    path: 'daily-report',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./daily-report/daily-report.component').then((m) => m.DailyReportComponent),
  },
  {
    path: 'reporting',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./reporting/schedule-reporting.component').then((m) => m.ScheduleReportingComponent),
  },
  {
    path: 'new',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./schedule-form/schedule-form.component').then((m) => m.ScheduleFormComponent),
  },
  {
    path: ':id',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./schedule-detail/schedule-detail.component').then((m) => m.ScheduleDetailComponent),
  },
  {
    path: ':id/edit',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./schedule-form/schedule-form.component').then((m) => m.ScheduleFormComponent),
  },
];
