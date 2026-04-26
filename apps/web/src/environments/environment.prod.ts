const runtimeKcUrl: string = (window as any).__BCMS_KEYCLOAK_URL__ || '';

export const environment = {
  production: true,
  skipAuth:   false,
  timezone:  'Europe/Istanbul',
  utcOffset: '+03:00',
  apiUrl: '/api/v1',
  keycloak: {
    url:      runtimeKcUrl || `${window.location.protocol}//${window.location.hostname}:8080`,
    realm:    'bcms',
    clientId: 'bcms-web',
  },
};
