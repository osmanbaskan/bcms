import { Routes } from '@angular/router';

export const bookingsRoutes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./booking-list/booking-list.component').then((m) => m.BookingListComponent),
  },
];
