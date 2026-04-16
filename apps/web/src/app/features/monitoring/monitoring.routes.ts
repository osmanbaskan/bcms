import { Routes } from '@angular/router';

export const monitoringRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./monitoring-dashboard/monitoring-dashboard.component').then(
        (m) => m.MonitoringDashboardComponent,
      ),
  },
];
