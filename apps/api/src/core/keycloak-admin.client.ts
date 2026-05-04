/**
 * Keycloak Admin API client with built-in token caching.
 * Replaces duplicated getAdminToken / kcFetch patterns across route modules.
 */

export interface KeycloakUserRepresentation {
  id?: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  attributes?: Record<string, string[] | string | undefined>;
  [extraField: string]: unknown;
}

let adminToken: string | null = null;
let tokenExpiry = 0;
/** HIGH-API-012 fix (2026-05-05): Concurrent refresh race koruması.
 *  Eski hâlinde N istek aynı anda gelirse her biri ayrı /token çağrısı
 *  açıyordu. Promise gate ile inflight refresh tek bir resolution paylaşır. */
let refreshPromise: Promise<string> | null = null;

function envOrDefault(key: string, fallback: string): string {
  const value = process.env[key];
  if (value !== undefined && value !== '') return value;
  if (process.env.NODE_ENV === 'production') {
    throw Object.assign(new Error(`${key} is required in production`), { statusCode: 500 });
  }
  return fallback;
}

async function fetchAdminToken(): Promise<string> {
  const url = envOrDefault('KEYCLOAK_URL', 'http://localhost:8080');
  const username = envOrDefault('KEYCLOAK_ADMIN', 'admin');
  const password = envOrDefault('KEYCLOAK_ADMIN_PASSWORD', 'changeme_kc');

  const res = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username,
      password,
    }),
  });

  if (!res.ok) {
    throw Object.assign(new Error('Keycloak admin auth failed'), { statusCode: 502 });
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  adminToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return adminToken;
}

export async function getAdminToken(): Promise<string> {
  // Cache'te geçerli token varsa anında dön
  if (adminToken && Date.now() < tokenExpiry - 10_000) return adminToken;
  // Inflight refresh varsa onu paylaş (race önleme)
  if (refreshPromise) return refreshPromise;
  refreshPromise = fetchAdminToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export async function kcFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const url = envOrDefault('KEYCLOAK_URL', 'http://localhost:8080');
  const realm = envOrDefault('KEYCLOAK_REALM', 'bcms');
  const token = await getAdminToken();

  const res = await fetch(`${url}/admin/realms/${realm}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(
      new Error(`Keycloak error: ${res.status} ${text}`),
      { statusCode: res.status },
    );
  }

  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}
