import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { KeycloakService } from 'keycloak-angular';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { environment } from '../../../environments/environment';
import { isSkipAuthAllowed } from '../auth/skip-auth';
import { getPublicAppOrigin } from '../auth/public-origin';
import { LoggerService } from '../services/logger.service';

const TOKEN_MIN_VALIDITY_SECONDS = 60;
const REDIRECT_THROTTLE_MS = 30_000;
const REDIRECT_THROTTLE_KEY = 'bcms_auth_last_redirect';

function isApiRequest(url: string): boolean {
  const api = new URL(environment.apiUrl, window.location.origin);
  const target = new URL(url, window.location.origin);
  return target.origin === api.origin && target.pathname.startsWith(api.pathname);
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  // ÖNEMLİ-FE-2.1.1 fix (2026-05-04): runtime guard — environment.skipAuth=true
  // bile prod hostname'inde devre dışı kalmalı; aksi halde prod build'de
  // bearer token eklenmez ve auth tamamen kapanır.
  if (!isApiRequest(req.url) || isSkipAuthAllowed()) {
    return next(req);
  }

  const keycloak = inject(KeycloakService);
  const logger = inject(LoggerService);

  const redirectToLogin = (err: unknown): void => {
    // Throttle: 30sn'de bir kereden fazla redirect etme — sayfanın sonsuz
    // reload loop'una düşmesini önler (defense-in-depth).
    const last = Number(sessionStorage.getItem(REDIRECT_THROTTLE_KEY) ?? '0');
    if (Date.now() - last < REDIRECT_THROTTLE_MS) {
      logger.warn('Auth redirect throttled (30s pencerede ikinci redirect engellendi)', err);
      return;
    }
    sessionStorage.setItem(REDIRECT_THROTTLE_KEY, String(Date.now()));
    logger.error('Auth interceptor token failure — redirecting to login', err);
    keycloak.login({ redirectUri: getPublicAppOrigin() }).catch(() => {
      window.location.assign(getPublicAppOrigin());
    });
  };

  return from(keycloak.updateToken(TOKEN_MIN_VALIDITY_SECONDS)).pipe(
    switchMap(() => from(keycloak.getToken())),
    switchMap((token: string) => {
      if (!token) throw new Error('No auth token after refresh');
      const authReq = req.clone({
        setHeaders: { Authorization: `Bearer ${token}` },
      });
      return next(authReq);
    }),
    catchError((err: unknown) => {
      // HTTP error (401 / 403 / 500 / vb.): component veya global error
      // handler işler. Burada redirect YAPMAYIZ — aksi halde server-side
      // permission hatası (örn. /channels 403 for Tekyon group) sayfayı
      // sonsuz reload loop'una sokar.
      if (err instanceof HttpErrorResponse) {
        return throwError(() => err);
      }
      // Token refresh / retrieval / Keycloak instance hatası → session
      // gerçekten bozuk, redirect mantıklı (throttle'lı).
      redirectToLogin(err);
      return throwError(() => err);
    }),
  );
};
