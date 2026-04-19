import { Routes } from '@angular/router';

export const schedulesRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./schedule-list/schedule-list.component').then((m) => m.ScheduleListComponent),
  },
  {
    path: 'daily-report',
    loadComponent: () =>
      import('./daily-report/daily-report.component').then((m) => m.DailyReportComponent),
  },
  {
    path: 'new',
    loadComponent: () =>
      import('./schedule-form/schedule-form.component').then((m) => m.ScheduleFormComponent),
  },
  {
    path: ':id',
    loadComponent: () =>
      import('./schedule-detail/schedule-detail.component').then((m) => m.ScheduleDetailComponent),
  },
  {
    path: ':id/edit',
    loadComponent: () =>
      import('./schedule-form/schedule-form.component').then((m) => m.ScheduleFormComponent),
  },
];
