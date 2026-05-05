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

const TOKEN_REFRESH_MIN_VALIDITY_SECONDS = 120;
const TOKEN_REFRESH_INTERVAL_MS = 60_000;

function initKeycloak(keycloak: KeycloakService, logger: LoggerService) {
  return async () => {
    await keycloak.init({
      config: {
        url:      environment.keycloak.url,
        realm:    environment.keycloak.realm,
        clientId: environment.keycloak.clientId,
      },
      initOptions: {
        // ORTA-FE-2.2.2 (2026-05-04): silent-check-sso entegrasyonu opsiyonel.
        // Şu anki davranış: login-required → her ziyarette Keycloak'a redirect.
        // Alternatif (UX akıcı): onLoad='check-sso' + silentCheckSsoRedirectUri
        // ile session iframe ile sessiz kontrol; oturum yoksa kullanıcı
        // explicit login butonu ile gönderir. UI kararı bekliyor — şu an
        // login-required kalıyor (mevcut akışın değiştirilmesi tüm sekmeleri
        // etkiler).
        onLoad: 'login-required',
        checkLoginIframe: false,
        redirectUri: `${getPublicAppOrigin()}/`,
        scope: 'openid profile email',
        // silentCheckSsoRedirectUri: `${getPublicAppOrigin()}/assets/silent-check-sso.html`,
      },
      loadUserProfileAtStartUp: false,
    });

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
