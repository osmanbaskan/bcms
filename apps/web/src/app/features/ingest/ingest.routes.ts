import { Routes } from '@angular/router';

export const ingestRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./ingest-list/ingest-list.component').then((m) => m.IngestListComponent),
  },
];
