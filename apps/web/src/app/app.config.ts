import { ApplicationConfig, APP_INITIALIZER } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { KeycloakService, KeycloakAngularModule } from 'keycloak-angular';
import { importProvidersFrom } from '@angular/core';

import { routes } from './app.routes';
import { environment } from '../environments/environment';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { getPublicAppOrigin } from './core/auth/public-origin';
import { LoggerService } from './core/services/logger.service';

// FA6 (2026-05-29, 250 user scale): min validity 120 → 180sn → her tick'te
// "180sn'lik geçerlilik kaldı mı" kontrol; varsa refresh skip → Keycloak'a
// req sıklığı %33 azalır (250 user × 60sn = ~4 req/sn → ~3 req/sn).
const TOKEN_REFRESH_MIN_VALIDITY_SECONDS = 180;
const TOKEN_REFRESH_INTERVAL_MS = 60_000;

function initKeycloak(keycloak: KeycloakService, logger: LoggerService) {
  return async () => {
    // P0.1 (2026-05-29, 250 user scale): silent-check-sso aktive edildi.
    // Eski: onLoad='login-required' → her sekme açışında Keycloak'a full
    // redirect (~2-3 sn flicker, session olsa bile).
    // Yeni: onLoad='check-sso' → silent iframe ile session sessizce kontrol
    // edilir; session varsa SPA redirect olmadan yüklenir (250 user × günlük
    // 20 tab × 2 sn ≈ kümülatif 3 saat kullanıcı zamanı kazancı).
    // Session yoksa fallback `keycloak.login()` çağrısı ile mevcut davranışa
    // dönülür (Keycloak login formuna redirect) — anonim SPA state'i YOK.
    await keycloak.init({
      config: {
        url:      environment.keycloak.url,
        realm:    environment.keycloak.realm,
        clientId: environment.keycloak.clientId,
      },
      initOptions: {
        onLoad: 'check-sso',
        checkLoginIframe: false,
        redirectUri: `${getPublicAppOrigin()}/`,
        scope: 'openid profile email',
        silentCheckSsoRedirectUri: `${getPublicAppOrigin()}/assets/silent-check-sso.html`,
      },
      loadUserProfileAtStartUp: false,
    });

    // Fallback: silent check session yoksa explicit login (mevcut akışla
    // eşdeğer redirect). Authentication zorunlu — anonim SPA state'i yok.
    if (!keycloak.getKeycloakInstance().authenticated) {
      await keycloak.login({ redirectUri: `${getPublicAppOrigin()}/` });
      return; // login() redirect başlatır; init devamı bu sekmede çalışmaz.
    }

    const kc = keycloak.getKeycloakInstance();
    kc.onTokenExpired = () => {
      void keycloak.updateToken(TOKEN_REFRESH_MIN_VALIDITY_SECONDS).catch((err) => {
        logger.warn('Keycloak token refresh failed after expiry', err);
      });
    };

    const refreshIntervalId = window.setInterval(() => {
      if (!kc.authenticated) return;
      void keycloak.updateToken(TOKEN_REFRESH_MIN_VALIDITY_SECONDS).catch((err) => {
        logger.warn('Keycloak token refresh failed', err);
      });
    }, TOKEN_REFRESH_INTERVAL_MS);

    // SPA bootstrap'ta tek sefer çalışır; pratikte browser sekmesi kapanınca GC.
    // Yine de HMR / test / micro-frontend bağlamında interval'ın sızmaması için
    // pagehide + beforeunload combo ile temizlik (DÜŞÜK-FE-2.8.5: mobile Safari
    // bazı durumlarda pagehide'ı atlayabiliyor — beforeunload defansif).
    const cleanup = () => clearInterval(refreshIntervalId);
    window.addEventListener('pagehide', cleanup, { once: true });
    window.addEventListener('beforeunload', cleanup, { once: true });
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAnimations(),
    provideHttpClient(withInterceptors([authInterceptor, errorInterceptor])),
    importProvidersFrom(KeycloakAngularModule),
    KeycloakService,
    {
      provide: APP_INITIALIZER,
      useFactory: initKeycloak,
      deps: [KeycloakService, LoggerService],
      multi: true,
    },
  ],
};
