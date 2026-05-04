export const environment = {
  production: false,
  skipAuth:   true,
  timezone:  'Europe/Istanbul',
  utcOffset: '+03:00',
  apiUrl: '/api/v1',
  keycloak: {
    // TLS reverse proxy mimarisi (2026-05-04): Browser https://beinport/ üzerinden bağlanır,
    // nginx /realms/, /admin/ path'lerini Keycloak'a proxy'ler.
    // `ng serve` (port 4200, Angular CLI dev) kullanırken bu URL ile çakışma olabilir;
    // o senaryo için alternatif: 'http://localhost:8080' (direct Keycloak bind).
    url:      'https://beinport',
    realm:    'bcms',
    clientId: 'bcms-web',
  },
};
