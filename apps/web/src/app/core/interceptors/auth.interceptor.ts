import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { catchError, from, of, switchMap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { LoggerService } from '../services/logger.service';

const TOKEN_MIN_VALIDITY_SECONDS = 60;

function isApiRequest(url: string): boolean {
  const api = new URL(environment.apiUrl, window.location.origin);
  const target = new URL(url, window.location.origin);
  return target.origin === api.origin && target.pathname.startsWith(api.pathname);
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const keycloak = inject(KeycloakService);
  const logger = inject(LoggerService);

  if (!isApiRequest(req.url)) {
    return next(req);
  }

  return from(keycloak.updateToken(TOKEN_MIN_VALIDITY_SECONDS)).pipe(
    catchError((err) => {
      logger.warn('Token refresh before API request failed', err);
      return of(false);
    }),
    switchMap(() => from(keycloak.getToken())),
    switchMap((token: string) => {
      if (token) {
        req = req.clone({
          setHeaders: { Authorization: `Bearer ${token}` },
        });
      }
      return next(req);
    }),
    catchError((err) => {
      logger.error('Token retrieval failed', err);
      return next(req);
    }),
  );
};
