import { environment } from '../../../environments/environment';

export function getPublicAppOrigin(): string {
  if (typeof window === 'undefined') return '';

  const current = window.location.origin;
  const host = window.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') return current;

  try {
    const keycloakUrl = new URL(environment.keycloak.url);
    const port = window.location.port || '4200';
    return `${window.location.protocol}//${keycloakUrl.hostname}:${port}`;
  } catch {
    return current;
  }
}

