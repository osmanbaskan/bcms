export const environment = {
  production: true,
  skipAuth: false,
  timezone:  'Europe/Istanbul',
  utcOffset: '+03:00',
  apiUrl: '/api/v1',
  keycloak: {
    url:      window.location.origin.replace(':4200', ':8080'),
    realm:    'bcms',
    clientId: 'bcms-web',
  },
};
