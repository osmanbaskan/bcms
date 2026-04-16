import { Routes } from '@angular/router';

export const channelsRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./channel-list/channel-list.component').then((m) => m.ChannelListComponent),
  },
];
