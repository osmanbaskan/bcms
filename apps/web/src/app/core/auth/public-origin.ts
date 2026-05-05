import { environment } from '../../../environments/environment';

// ORTA-FE-2.1.4 fix (2026-05-04): isSkipAuthAllowed regex'iyle aynı host
// listesi — `.local`, IPv6 `[::1]`, `0.0.0.0` da private kabul edilsin.
const PRIVATE_HOSTNAME_REGEX = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|.*\.local)$/i;

export function getPublicAppOrigin(): string {
  if (typeof window === 'undefined') return '';

  const current = window.location.origin;
  const host = window.location.hostname.toLowerCase();
  if (!PRIVATE_HOSTNAME_REGEX.test(host)) return current;

  try {
    const keycloakUrl = new URL(environment.keycloak.url);
    const port = window.location.port || '4200';
    return `${window.location.protocol}//${keycloakUrl.hostname}:${port}`;
  } catch {
    return current;
  }
}

