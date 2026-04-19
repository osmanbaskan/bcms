import { Routes } from '@angular/router';
import { AuthGuard } from './core/guards/auth.guard';

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
    data: { roles: ['admin', 'planner', 'scheduler', 'viewer'] },
  },
  {
    path: 'bookings',
    loadChildren: () =>
      import('./features/bookings/bookings.routes').then((m) => m.bookingsRoutes),
    canActivate: [AuthGuard],
    data: { roles: ['admin', 'planner', 'scheduler', 'viewer'] },
  },
  {
    path: 'channels',
    loadChildren: () =>
      import('./features/channels/channels.routes').then((m) => m.channelsRoutes),
    canActivate: [AuthGuard],
    data: { roles: ['admin'] },
  },
  {
    path: 'ingest',
    loadChildren: () =>
      import('./features/ingest/ingest.routes').then((m) => m.ingestRoutes),
    canActivate: [AuthGuard],
    data: { roles: ['admin', 'ingest_operator'] },
  },
  {
    path: 'monitoring',
    loadChildren: () =>
      import('./features/monitoring/monitoring.routes').then((m) => m.monitoringRoutes),
    canActivate: [AuthGuard],
    data: { roles: ['admin', 'monitoring', 'viewer'] },
  },
  {
    path: 'mcr',
    loadChildren: () =>
      import('./features/mcr/mcr.routes').then((m) => m.mcrRoutes),
    canActivate: [AuthGuard],
    data: { roles: ['admin', 'monitoring'] },
  },
  {
    path: 'users',
    loadChildren: () =>
      import('./features/users/users.routes').then((m) => m.usersRoutes),
    canActivate: [AuthGuard],
    data: { roles: ['admin'] },
  },
  { path: '**', redirectTo: '/schedules' },
];
