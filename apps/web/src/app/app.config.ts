import { ApplicationConfig, APP_INITIALIZER } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { KeycloakService, KeycloakAngularModule } from 'keycloak-angular';
import { importProvidersFrom } from '@angular/core';

import { routes } from './app.routes';
import { environment } from '../environments/environment';
import { authInterceptor } from './core/interceptors/auth.interceptor';
import { getPublicAppOrigin } from './core/auth/public-origin';

const TOKEN_REFRESH_MIN_VALIDITY_SECONDS = 120;
const TOKEN_REFRESH_INTERVAL_MS = 60_000;

function initKeycloak(keycloak: KeycloakService) {
  return async () => {
    await keycloak.init({
      config: {
        url:      environment.keycloak.url,
        realm:    environment.keycloak.realm,
        clientId: environment.keycloak.clientId,
      },
      initOptions: {
        onLoad: 'login-required',
        checkLoginIframe: false,
        redirectUri: `${getPublicAppOrigin()}/`,
        scope: 'openid profile email',
      },
      loadUserProfileAtStartUp: false,
    });

    const kc = keycloak.getKeycloakInstance();
    kc.onTokenExpired = () => {
      void keycloak.updateToken(TOKEN_REFRESH_MIN_VALIDITY_SECONDS).catch((err) => {
        console.warn('Keycloak token refresh failed after expiry', err);
      });
    };

    window.setInterval(() => {
      if (!kc.authenticated) return;
      void keycloak.updateToken(TOKEN_REFRESH_MIN_VALIDITY_SECONDS).catch((err) => {
        console.warn('Keycloak token refresh failed', err);
      });
    }, TOKEN_REFRESH_INTERVAL_MS);
  };
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAnimations(),
    provideHttpClient(withInterceptors([authInterceptor])),
    importProvidersFrom(KeycloakAngularModule),
    KeycloakService,
    {
      provide: APP_INITIALIZER,
      useFactory: initKeycloak,
      deps: [KeycloakService],
      multi: true,
    },
  ],
};
