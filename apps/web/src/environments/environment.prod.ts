export const environment = {
  production: true,
  skipAuth:   false,
  timezone:  'Europe/Istanbul',
  utcOffset: '+03:00',
  apiUrl: '/api/v1',
  keycloak: {
    url:      `${window.location.protocol}//${window.location.hostname}:8080`,
    realm:    'bcms',
    clientId: 'bcms-web',
  },
};
