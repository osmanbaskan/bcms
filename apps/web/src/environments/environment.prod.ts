export const environment = {
  production: true,
  apiUrl: '/api/v1',
  keycloak: {
    url:      window.location.origin.replace(':4200', ':8080'),
    realm:    'bcms',
    clientId: 'bcms-web',
  },
};
