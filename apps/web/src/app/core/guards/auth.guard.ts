import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, RouterStateSnapshot, Router, UrlTree } from '@angular/router';
import { KeycloakAuthGuard, KeycloakService } from 'keycloak-angular';
import type { KeycloakTokenParsed } from 'keycloak-js';
import { getPublicAppOrigin } from '../auth/public-origin';
import { GROUP } from '@bcms/shared';

interface BcmsTokenParsed extends KeycloakTokenParsed {
  groups?: string[];
}

@Injectable({ providedIn: 'root' })
export class AuthGuard extends KeycloakAuthGuard {
  constructor(
    protected override readonly router: Router,
    protected readonly keycloak: KeycloakService,
  ) {
    super(router, keycloak);
  }

  override async canActivate(
    route: ActivatedRouteSnapshot,
    state: RouterStateSnapshot,
  ): Promise<boolean | UrlTree> {
    return super.canActivate(route, state);
  }

  /** HIGH-FE-011 fix (2026-05-05): blanket child route protection.
   *  KeycloakAuthGuard.canActivate'i child route navigation'ında da çalıştır;
   *  böylece app.routes.ts'de loadChildren parent'ına `canActivateChild` eklemek
   *  yeterli — child route dosyalarına eklemek gerekmez. */
  async canActivateChild(
    route: ActivatedRouteSnapshot,
    state: RouterStateSnapshot,
  ): Promise<boolean | UrlTree> {
    return this.canActivate(route, state);
  }

  async isAccessAllowed(route: ActivatedRouteSnapshot): Promise<boolean | UrlTree> {
    if (!this.authenticated) {
      try {
        await this.keycloak.login({ redirectUri: new URL(window.location.pathname + window.location.search + window.location.hash, getPublicAppOrigin()).href });
      } catch {
        return this.router.parseUrl('/login-error');
      }
      return false;
    }

    const requiredGroups: string[] = route.data['groups'] ?? [];
    if (requiredGroups.length === 0) return true;

    const tokenParsed = this.keycloak.getKeycloakInstance().tokenParsed as BcmsTokenParsed | undefined;
    const userGroups: string[] = tokenParsed?.groups ?? [];
    if (userGroups.includes(GROUP.Admin)) return true;
    const hasGroup = requiredGroups.some((g) => userGroups.includes(g));
    if (!hasGroup) return this.router.parseUrl('/schedules');

    return true;
  }
}
