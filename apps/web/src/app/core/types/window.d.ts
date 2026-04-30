export {};

declare global {
  interface Window {
    __BCMS_KEYCLOAK_URL__?: string;
  }
}
