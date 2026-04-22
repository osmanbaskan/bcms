import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { from, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';

function isApiRequest(url: string): boolean {
  const api = new URL(environment.apiUrl, window.location.origin);
  const target = new URL(url, window.location.origin);
  return target.origin === api.origin && target.pathname.startsWith(api.pathname);
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  // skipAuth modunda token ekleme
  if (environment.skipAuth) return next(req);

  const keycloak = inject(KeycloakService);

  if (!isApiRequest(req.url)) {
    return next(req);
  }

  return from(keycloak.getToken()).pipe(
    switchMap((token) => {
      if (token) {
        req = req.clone({
          setHeaders: { Authorization: `Bearer ${token}` },
        });
      }
      return next(req);
    }),
  );
};
