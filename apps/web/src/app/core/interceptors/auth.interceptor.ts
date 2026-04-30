import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { getPublicAppOrigin } from '../auth/public-origin';
import { LoggerService } from '../services/logger.service';

const TOKEN_MIN_VALIDITY_SECONDS = 60;

function isApiRequest(url: string): boolean {
  const api = new URL(environment.apiUrl, window.location.origin);
  const target = new URL(url, window.location.origin);
  return target.origin === api.origin && target.pathname.startsWith(api.pathname);
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isApiRequest(req.url) || environment.skipAuth) {
    return next(req);
  }

  const keycloak = inject(KeycloakService);
  const logger = inject(LoggerService);

  return from(keycloak.updateToken(TOKEN_MIN_VALIDITY_SECONDS)).pipe(
    switchMap(() => from(keycloak.getToken())),
    switchMap((token: string) => {
      if (!token) {
        return throwError(() => new Error('No auth token available'));
      }
      const authReq = req.clone({
        setHeaders: { Authorization: `Bearer ${token}` },
      });
      return next(authReq);
    }),
    catchError((err) => {
      // Token refresh veya retrieval başarısızsa request'i auth header'sız
      // göndermek 401 üretir ve session kurtarma akışı asla tetiklenmez.
      // Bunun yerine kullanıcıyı login akışına yönlendir ve hatayı propaate et.
      logger.error('Auth interceptor failure — redirecting to login', err);
      keycloak.login({ redirectUri: getPublicAppOrigin() }).catch(() => {
        // login() rejection durumunda fallback: hard reload
        window.location.assign(getPublicAppOrigin());
      });
      return throwError(() => err);
    }),
  );
};
