/// <reference path="../app/core/types/window.d.ts" />

const runtimeKcUrl: string = window.__BCMS_KEYCLOAK_URL__ ?? '';

export const environment = {
  production: true,
  skipAuth:   false,
  timezone:  'Europe/Istanbul',
  utcOffset: '+03:00',
  apiUrl: '/api/v1',
  keycloak: {
    // TLS reverse proxy mimarisi: nginx edge'de TLS termination + path-based routing.
    // Runtime config (window.__BCMS_KEYCLOAK_URL__) BCMS_KEYCLOAK_PUBLIC_URL env'den gelir
    // (docker-compose ile container'a injected). Default fallback: same-origin (port'suz).
    url:      runtimeKcUrl || `${window.location.protocol}//${window.location.host}`,
    realm:    'bcms',
    clientId: 'bcms-web',
  },
};
