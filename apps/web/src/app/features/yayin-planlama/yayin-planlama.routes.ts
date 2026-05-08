import { Routes } from '@angular/router';
import { AuthGuard } from '../../core/guards/auth.guard';

/**
 * SCHED-B4 (Y4-2): Yayın Planlama feature routes.
 *
 * /yayin-planlama          → liste
 * /yayin-planlama/new      → yeni
 * /yayin-planlama/:id/edit → düzenle
 *
 * Detail route MVP'den çıkarıldı (Y4-7); entity DTO list + form'da görünür.
 */
export const yayinPlanlamaRoutes: Routes = [
  {
    path: '',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./yayin-planlama-list.component').then((m) => m.YayinPlanlamaListComponent),
  },
  {
    path: 'new',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./yayin-planlama-form.component').then((m) => m.YayinPlanlamaFormComponent),
  },
  {
    path: ':id/edit',
    canActivate: [AuthGuard],
    data: { groups: [] },
    loadComponent: () =>
      import('./yayin-planlama-form.component').then((m) => m.YayinPlanlamaFormComponent),
  },
];
