import { Routes } from '@angular/router';
import { AuthGuard } from './core/guards/auth.guard';
import { GROUP } from '@bcms/shared';

/**
 * HIGH-FE-011 fix (2026-05-05): loadChildren ile gelen feature route'larda
 * `canActivateChild: [AuthGuard]` blanket protection. Aksi halde child route
 * dosyalarına yanlışlıkla `canActivate` eklenmezse, sadece parent guard'ı
 * lazy-load anında çalışır ve sonraki direct child URL ziyaretleri korunmaz.
 */
export const routes: Routes = [
  {
    path: '',
    redirectTo: '/dashboard',
    pathMatch: 'full',
  },
  {
    path: 'dashboard',
    loadChildren: () =>
      import('./features/dashboard/dashboard.routes').then((m) => m.dashboardRoutes),
    canActivate: [AuthGuard],
    canActivateChild: [AuthGuard],
    data: { groups: [] },
  },
  {
    path: 'schedules',
    loadChildren: () =>
      import('./features/schedules/schedules.routes').then((m) => m.schedulesRoutes),
    canActivate: [AuthGuard],
    canActivateChild: [AuthGuard],
    data: { groups: [] },
  },
  {
    path: 'bookings',
    loadChildren: () =>
      import('./features/bookings/bookings.routes').then((m) => m.bookingsRoutes),
    canActivate: [AuthGuard],
    canActivateChild: [AuthGuard],
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
    canActivateChild: [AuthGuard],
    data: { groups: [GROUP.Admin] },
  },
  {
    path: 'ingest',
    loadChildren: () =>
      import('./features/ingest/ingest.routes').then((m) => m.ingestRoutes),
    canActivate: [AuthGuard],
    canActivateChild: [AuthGuard],
    data: { groups: [GROUP.Admin, GROUP.Ingest] },
  },
  {
    path: 'monitoring',
    loadChildren: () =>
      import('./features/monitoring/monitoring.routes').then((m) => m.monitoringRoutes),
    canActivate: [AuthGuard],
    canActivateChild: [AuthGuard],
    data: { groups: [GROUP.Admin] },
  },
  {
    path: 'mcr',
    loadChildren: () =>
      import('./features/mcr/mcr.routes').then((m) => m.mcrRoutes),
    canActivate: [AuthGuard],
    canActivateChild: [AuthGuard],
    data: { groups: [GROUP.Admin, GROUP.MCR] },
  },
  {
    path: 'users',
    loadChildren: () =>
      import('./features/users/users.routes').then((m) => m.usersRoutes),
    canActivate: [AuthGuard],
    canActivateChild: [AuthGuard],
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
  {
    /** Madde 5 M5-B6 (2026-05-06): Live-plan lookup master data yönetimi.
     *  Page-level read = all authenticated; write/delete butonları
     *  PERMISSIONS.livePlanLookups.write/delete (SystemEng + Admin auto-bypass)
     *  ile component içinde gizlenir. */
    path: 'admin/live-plan-lookups',
    loadComponent: () =>
      import('./features/live-plan/admin-lookups/admin-lookups.component').then((m) => m.AdminLookupsComponent),
    canActivate: [AuthGuard],
    data: { groups: [] },
  },
  {
    /** Madde 5 M5-B10a (2026-05-07): yeni Live-Plan ekranı (paralel; mevcut
     *  /schedules dokunulmaz). Y1 lock. List + detail (segments-only iskelet);
     *  76 alan technical-details form M5-B10b'de. Page-level read = all-auth;
     *  write/delete butonları component içi role-check. */
    path: 'live-plan',
    loadChildren: () =>
      import('./features/live-plan/live-plan.routes').then((m) => m.livePlanRoutes),
    canActivate: [AuthGuard],
    canActivateChild: [AuthGuard],
    data: { groups: [] },
  },
  // ORTA-FE-2.6.1 fix (2026-05-04): /login-error route eklendi.
  // auth.guard.ts hata path'inde parseUrl('/login-error') döndürüyordu;
  // route tanımlı değildi → ** wildcard ile /schedules'a düşüyor ve kullanıcı
  // hatayı göremeden anasayfaya atıyordu. Artık ayrı bir login-error
  // ekranı kullanıcıya net mesaj gösterir.
  {
    path: 'login-error',
    loadComponent: () =>
      import('./features/login-error/login-error.component').then((m) => m.LoginErrorComponent),
  },
  { path: '**', redirectTo: '/schedules' },
];
