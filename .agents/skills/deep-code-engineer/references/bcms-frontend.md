# BCMS Frontend Patterns Reference

Load this reference when writing or editing Angular components, services, routes, or templates.

## Technology Stack

- Angular 21.2.8, **Standalone Components**, **Signals-first**
- Angular Material M3 Dark theme
- Keycloak Angular (`KeycloakAuthGuard`, `KeycloakService`)
- RxJS for HTTP, Signals for local state

## Signals-First State Management

**Rule:** Prefer Angular Signals (`signal()`, `computed()`) over RxJS `BehaviorSubject` for component-local state.

**Pattern:**
```ts
users = signal<KcUser[]>([]);
loading = signal(true);
visibleItems = computed(() => this.users().filter(u => u.enabled));
```

**Anti-pattern:** Using `BehaviorSubject` + `async` pipe for simple boolean or array state.

## Group-Based Navigation Visibility

**Pattern:**
```ts
_userGroups = signal<string[]>([]);
canEdit = computed(() => hasGroup(this._userGroups(), SCHEDULE_PERMS.edit));
```

- `hasGroup(userGroups, required)` checks intersection.
- `SCHEDULE_PERMS` maps actions to required groups.
- Nav items filtered via `computed(() => navItems.filter(...))` in `app.component.ts`.

## Auth Guard Pattern

**File:** `core/guards/auth.guard.ts`

```ts
export class AuthGuard extends KeycloakAuthGuard {
  async isAccessAllowed(route: ActivatedRouteSnapshot): Promise<boolean | UrlTree> {
    if (!this.authenticated) { await this.keycloak.login(...); return false; }
    const requiredGroups: string[] = route.data['groups'] ?? [];
    if (requiredGroups.length === 0) return true;
    const userGroups = (this.keycloak.getKeycloakInstance().tokenParsed as any)?.groups ?? [];
    return requiredGroups.some(g => userGroups.includes(g)) ? true : this.router.parseUrl('/schedules');
  }
}
```

- Empty `groups` array = any authenticated user.
- Mismatch redirects to `/schedules`.

## API Service Pattern

**File:** `core/services/api.service.ts`

- `get`, `post`, `put`, `patch`, `delete`, `postFile`, `getBlob`
- `patch` accepts optional `version` → adds `If-Match` header for optimistic locking.
- `getBlob` for file downloads (Excel/PDF exports).

**Pattern:**
```ts
this.api.patch<Schedule>(`/schedules/${id}`, body, version).subscribe(...)
```

## Component Size Limits

**Rule:** Keep components under ~300 lines. Extract dialogs and complex forms into separate standalone components.

**Current violation:** `schedule-list.component.ts` is 1954 lines with 4 inline dialogs. Refactor target: extract each dialog to its own file.

## Dialog Patterns

- Use `MAT_DIALOG_DATA` + `inject()` for data injection.
- Use `MatDialogRef` for close/result handling.
- Dialogs are standalone components with their own imports.
- After close, refresh parent list via callback or direct `.load()` call.

## Form Patterns

- Use `ngModel` with `[ngModelOptions]="{standalone:true}"` for simple forms.
- No `FormGroup`/`FormBuilder` unless complex validation chains needed.
- Validate in save handler, not in template.

## Route Lazy Loading

```ts
{
  path: 'schedules',
  loadChildren: () => import('./features/schedules/schedules.routes').then(m => m.schedulesRoutes),
  canActivate: [AuthGuard],
  data: { groups: [] },
}
```

- `loadChildren` for feature modules with multiple routes.
- `loadComponent` for single-route features.

## Dev Bypass (Deprecated but Present)

`environment.skipAuth` = true → `username='dev-admin'`, `userGroups=['Sistem Muhendisligi']`.
Do not rely on this for new features. Production blocks `SKIP_AUTH=true`.
