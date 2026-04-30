import { Routes } from '@angular/router';
import { AuthGuard } from './core/guards/auth.guard';
import { GROUP } from '@bcms/shared';

export const routes: Routes = [
  {
    path: '',
    redirectTo: '/schedules',
    pathMatch: 'full',
  },
  {
    path: 'schedules',
    loadChildren: () =>
      import('./features/schedules/schedules.routes').then((m) => m.schedulesRoutes),
    canActivate: [AuthGuard],
    data: { groups: [] },
  },
  {
    path: 'bookings',
    loadChildren: () =>
      import('./features/bookings/bookings.routes').then((m) => m.bookingsRoutes),
    canActivate: [AuthGuard],
    data: { groups: [] },
  },
  {
    path: 'studio-plan',
    loadComponent: () =>
      import('./features/studio-plan/studio-plan.component').then((m) => m.StudioPlanComponent),
    canActivate: [AuthGuard],
    data: { groups: [] },
  },
  {
    path: 'weekly-shift',
    loadComponent: () =>
      import('./features/weekly-shift/weekly-shift.component').then((m) => m.WeeklyShiftComponent),
    canActivate: [AuthGuard],
    data: { groups: [] },
  },
  {
    path: 'provys-content-control',
    loadComponent: () =>
      import('./features/provys-content-control/provys-content-control.component').then((m) => m.ProvysContentControlComponent),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.Admin] },
  },
  {
    path: 'channels',
    loadChildren: () =>
      import('./features/channels/channels.routes').then((m) => m.channelsRoutes),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.SystemEng] },
  },
  {
    path: 'ingest',
    loadChildren: () =>
      import('./features/ingest/ingest.routes').then((m) => m.ingestRoutes),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.Admin, GROUP.Ingest] },
  },
  {
    path: 'monitoring',
    loadChildren: () =>
      import('./features/monitoring/monitoring.routes').then((m) => m.monitoringRoutes),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.Admin] },
  },
  {
    path: 'mcr',
    loadChildren: () =>
      import('./features/mcr/mcr.routes').then((m) => m.mcrRoutes),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.Admin, GROUP.MCR] },
  },
  {
    path: 'users',
    loadChildren: () =>
      import('./features/users/users.routes').then((m) => m.usersRoutes),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.SystemEng] },
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./features/settings/settings.component').then((m) => m.SettingsComponent),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.SystemEng] },
  },
  {
    path: 'audit-logs',
    loadComponent: () =>
      import('./features/audit/audit-log.component').then((m) => m.AuditLogComponent),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.SystemEng] },
  },
  {
    path: 'documents',
    loadComponent: () =>
      import('./features/documents/documents.component').then((m) => m.DocumentsComponent),
    canActivate: [AuthGuard],
    data: { groups: [GROUP.SystemEng] },
  },
  { path: '**', redirectTo: '/schedules' },
];
