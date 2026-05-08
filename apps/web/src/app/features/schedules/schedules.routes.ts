import { Routes } from '@angular/router';
import { GROUP } from '@bcms/shared';
import { AuthGuard } from '../../core/guards/auth.guard';

export const schedulesRoutes: Routes = [
  {
    /** SCHED-B4 (revize 2026-05-08): "Canlı Yayın Plan" sekmesi kullanıcı
     *  algısında korunur — eski schedule-list UI eskisi gibi açılır.
     *  Redirect KALDIRILDI (önceki revizede yanlışlıkla eklenmişti);
     *  schedule-list bileşeni B5 destructive cleanup'a kadar paralel kalır.
     *  Yeni broadcast flow ayrı sekme: /yayin-planlama. */
    path: '',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./schedule-list/schedule-list.component').then((m) => m.ScheduleListComponent),
  },
  {
    path: 'reporting',
    canActivate: [AuthGuard],
    // 2026-05-01: Raporlama Admin-only. Backend de PERMISSIONS.reports.read=['Admin'].
    data: { groups: [GROUP.Admin] },
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
