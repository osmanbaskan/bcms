/// <reference path="../app/core/types/window.d.ts" />

// DÜŞÜK-FE-2.2.4 fix (2026-05-04): runtime config 404 senaryosu daha açık.
// envsubst başarısız olur veya BCMS_KEYCLOAK_PUBLIC_URL env'i set edilmemiş
// olursa template literal "${BCMS_KEYCLOAK_PUBLIC_URL}" string olarak
// sızabilir; bunu da boş kabul et.
const TEMPLATE_LEAK_RE = /^\$\{[A-Z_]+\}$/;
const rawRuntimeKcUrl: string = window.__BCMS_KEYCLOAK_URL__ ?? '';
const runtimeKcUrl: string = TEMPLATE_LEAK_RE.test(rawRuntimeKcUrl) ? '' : rawRuntimeKcUrl;

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
