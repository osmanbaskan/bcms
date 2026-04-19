import type { FastifyInstance } from 'fastify';
import { PERMISSIONS } from '@bcms/shared';

const REALM_ROLES = ['admin', 'planner', 'scheduler', 'ingest_operator', 'monitoring', 'viewer'];

let adminToken: string | null = null;
let tokenExpiry = 0;

async function getAdminToken(): Promise<string> {
  if (adminToken && Date.now() < tokenExpiry - 10_000) return adminToken;

  const url      = process.env.KEYCLOAK_URL    ?? 'http://localhost:8080';
  const realm    = process.env.KEYCLOAK_REALM  ?? 'bcms';
  const username = process.env.KEYCLOAK_ADMIN           ?? 'admin';
  const password = process.env.KEYCLOAK_ADMIN_PASSWORD  ?? 'changeme_kc';

  const res = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id:  'admin-cli',
      username,
      password,
    }),
  });

  if (!res.ok) throw Object.assign(new Error('Keycloak admin auth failed'), { statusCode: 502 });
  const data = await res.json() as { access_token: string; expires_in: number };
  adminToken  = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return adminToken;
}

async function kcFetch(path: string, options: RequestInit = {}) {
  const url   = process.env.KEYCLOAK_URL   ?? 'http://localhost:8080';
  const realm = process.env.KEYCLOAK_REALM ?? 'bcms';
  const token = await getAdminToken();
  const res = await fetch(`${url}/admin/realms/${realm}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`Keycloak error: ${res.status} ${text}`), { statusCode: res.status });
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function usersRoutes(app: FastifyInstance) {

  // GET /api/v1/users
  app.get('/', {
    preHandler: app.requireRole(...PERMISSIONS.auditLogs.read), // admin only
    schema: { tags: ['Users'], summary: 'Keycloak kullanıcı listesi' },
  }, async () => {
    const users: any[] = await kcFetch('/users?max=200');

    // Her kullanıcının realm rollerini çek
    const withRoles = await Promise.all(users.map(async (u) => {
      const roleMappings: any[] = await kcFetch(`/users/${u.id}/role-mappings/realm`);
      const roles = roleMappings
        .map((r) => r.name as string)
        .filter((r) => REALM_ROLES.includes(r));
      return {
        id:        u.id,
        username:  u.username,
        email:     u.email ?? '',
        firstName: u.firstName ?? '',
        lastName:  u.lastName ?? '',
        enabled:   u.enabled ?? true,
        roles,
      };
    }));

    return withRoles;
  });

  // GET /api/v1/users/roles  — atanabilir roller listesi
  app.get('/roles', {
    preHandler: app.requireRole(...PERMISSIONS.auditLogs.read),
    schema: { tags: ['Users'], summary: 'Atanabilir rol listesi' },
  }, async () => REALM_ROLES);

  // PUT /api/v1/users/:id/roles  — roller güncelle
  app.put<{ Params: { id: string }; Body: { roles: string[] } }>('/:id/roles', {
    preHandler: app.requireRole(...PERMISSIONS.auditLogs.read),
    schema: {
      tags: ['Users'],
      summary: 'Kullanıcı rollerini güncelle',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body:   { type: 'object', properties: { roles: { type: 'array', items: { type: 'string' } } }, required: ['roles'] },
    },
  }, async (request) => {
    const { id } = request.params;
    const { roles: newRoles } = request.body;

    // Mevcut roller
    const current: any[] = await kcFetch(`/users/${id}/role-mappings/realm`);
    const currentBcms = current.filter((r) => REALM_ROLES.includes(r.name));

    // Tüm realm rollerinin id/name listesini al
    const allRoles: any[] = await kcFetch('/roles');
    const roleMap = new Map(allRoles.map((r) => [r.name, { id: r.id, name: r.name }]));

    // Kaldırılacaklar
    const toRemove = currentBcms.filter((r) => !newRoles.includes(r.name));
    if (toRemove.length > 0) {
      await kcFetch(`/users/${id}/role-mappings/realm`, { method: 'DELETE', body: JSON.stringify(toRemove) });
    }

    // Eklenecekler
    const currentNames = new Set(currentBcms.map((r) => r.name));
    const toAdd = newRoles.filter((r) => !currentNames.has(r) && roleMap.has(r)).map((r) => roleMap.get(r)!);
    if (toAdd.length > 0) {
      await kcFetch(`/users/${id}/role-mappings/realm`, { method: 'POST', body: JSON.stringify(toAdd) });
    }

    return { ok: true };
  });

  // PATCH /api/v1/users/:id/enabled  — aktif/pasif
  app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>('/:id/enabled', {
    preHandler: app.requireRole(...PERMISSIONS.auditLogs.read),
    schema: {
      tags: ['Users'],
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body:   { type: 'object', properties: { enabled: { type: 'boolean' } }, required: ['enabled'] },
    },
  }, async (request) => {
    const { id } = request.params;
    await kcFetch(`/users/${id}`, { method: 'PUT', body: JSON.stringify({ enabled: request.body.enabled }) });
    return { ok: true };
  });

  // POST /api/v1/users  — yeni kullanıcı
  app.post<{ Body: { username: string; email: string; firstName?: string; lastName?: string; password: string; roles: string[] } }>('/', {
    preHandler: app.requireRole(...PERMISSIONS.auditLogs.read),
    schema: {
      tags: ['Users'],
      summary: 'Yeni kullanıcı oluştur',
      body: {
        type: 'object',
        required: ['username', 'email', 'password', 'roles'],
        properties: {
          username:  { type: 'string' },
          email:     { type: 'string' },
          firstName: { type: 'string' },
          lastName:  { type: 'string' },
          password:  { type: 'string' },
          roles:     { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request) => {
    const { username, email, firstName, lastName, password, roles } = request.body;

    // Kullanıcıyı oluştur
    const url   = process.env.KEYCLOAK_URL   ?? 'http://localhost:8080';
    const realm = process.env.KEYCLOAK_REALM ?? 'bcms';
    const token = await getAdminToken();

    const createRes = await fetch(`${url}/admin/realms/${realm}/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username, email, firstName, lastName,
        enabled: true,
        credentials: [{ type: 'password', value: password, temporary: true }],
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      throw Object.assign(new Error(`Kullanıcı oluşturulamadı: ${text}`), { statusCode: createRes.status });
    }

    // Oluşturulan kullanıcının id'sini al (Location header'dan)
    const location = createRes.headers.get('Location') ?? '';
    const newId = location.split('/').pop()!;

    // Rolleri ata
    if (roles.length > 0) {
      const allRoles: any[] = await kcFetch('/roles');
      const toAdd = roles
        .map((r) => allRoles.find((ar) => ar.name === r))
        .filter(Boolean);
      if (toAdd.length > 0) {
        await kcFetch(`/users/${newId}/role-mappings/realm`, { method: 'POST', body: JSON.stringify(toAdd) });
      }
    }

    return { id: newId, username };
  });
}
