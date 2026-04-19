export const environment = {
  production: false,
  skipAuth: false,
  apiUrl: 'http://localhost:3000/api/v1',
  keycloak: {
    url:      'http://localhost:8080',
    realm:    'bcms',
    clientId: 'bcms-web',
  },
};
