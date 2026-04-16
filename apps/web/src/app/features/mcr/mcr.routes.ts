import { Routes } from '@angular/router';

export const mcrRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./mcr-panel/mcr-panel.component').then((m) => m.McrPanelComponent),
  },
];
