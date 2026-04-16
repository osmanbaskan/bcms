import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { from, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  // skipAuth modunda token ekleme
  if (environment.skipAuth) return next(req);

  const keycloak = inject(KeycloakService);

  // Only attach token to API calls
  if (!req.url.startsWith('/api') && !req.url.startsWith('http://localhost:3000')) {
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
