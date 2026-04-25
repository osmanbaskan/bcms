export const environment = {
  production: false,
  skipAuth:   true,
  timezone:  'Europe/Istanbul',
  utcOffset: '+03:00',
  apiUrl: '/api/v1',
  keycloak: {
    url:      'http://localhost:8080',
    realm:    'bcms',
    clientId: 'bcms-web',
  },
};
