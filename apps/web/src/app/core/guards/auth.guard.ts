import { Injectable } from '@angular/core';
import { ActivatedRouteSnapshot, RouterStateSnapshot, Router, UrlTree } from '@angular/router';
import { KeycloakAuthGuard, KeycloakService } from 'keycloak-angular';

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

  async isAccessAllowed(route: ActivatedRouteSnapshot): Promise<boolean | UrlTree> {
    if (!this.authenticated) {
      await this.keycloak.login({ redirectUri: window.location.href });
      return false;
    }

    const requiredGroups: string[] = route.data['groups'] ?? [];
    if (requiredGroups.length === 0) return true;

    const tokenParsed = this.keycloak.getKeycloakInstance().tokenParsed as any;
    const userGroups: string[] = tokenParsed?.groups ?? [];
    const hasGroup = requiredGroups.some((g) => userGroups.includes(g));
    if (!hasGroup) return this.router.parseUrl('/schedules');

    return true;
  }
}
