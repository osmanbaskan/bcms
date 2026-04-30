import type { KeycloakTokenParsed } from 'keycloak-js';

export interface BcmsTokenParsed extends KeycloakTokenParsed {
  preferred_username?: string;
  email?: string;
  groups?: string[];
}
