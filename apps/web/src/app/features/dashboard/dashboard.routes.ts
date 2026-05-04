import { Routes } from '@angular/router';
import { AuthGuard } from '../../core/guards/auth.guard';

export const dashboardRoutes: Routes = [
  {
    path: '',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./dashboard.component').then((m) => m.DashboardComponent),
  },
];
