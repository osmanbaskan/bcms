import type { FastifyInstance } from 'fastify';
import { BCMS_GROUPS, PERMISSIONS, type BcmsGroup } from '@bcms/shared';
import { getAdminToken, kcFetch } from '../../core/keycloak-admin.client.js';

const USER_TYPES = ['staff', 'supervisor', 'admin'] as const;
type UserType = typeof USER_TYPES[number];

// User-group membership cache (60 s TTL)
const groupMembershipCache = new Map<string, { groups: string[]; expiresAt: number }>();
const GROUP_CACHE_TTL_MS = 60_000;

function getCachedGroups(userId: string): string[] | null {
  const entry = groupMembershipCache.get(userId);
  if (entry && Date.now() < entry.expiresAt) return entry.groups;
  groupMembershipCache.delete(userId);
  return null;
}

function setCachedGroups(userId: string, groups: string[]): void {
  groupMembershipCache.set(userId, { groups, expiresAt: Date.now() + GROUP_CACHE_TTL_MS });
}

// Group name → ID map cache (5 min TTL — group names rarely change)
let groupIdMapCache: Map<string, string> | null = null;
let groupIdMapExpiry = 0;
const GROUP_ID_MAP_TTL_MS = 5 * 60_000;

async function getGroupIdMap(): Promise<Map<string, string>> {
  if (groupIdMapCache && Date.now() < groupIdMapExpiry) return groupIdMapCache;
  const groups = await kcFetch<any[]>('/groups');
  groupIdMapCache = new Map(groups.map((g: any) => [g.name as string, g.id as string]));
  groupIdMapExpiry = Date.now() + GROUP_ID_MAP_TTL_MS;
  return groupIdMapCache;
}

function keycloakAttributeValue(attributes: any, key: string): string | undefined {
  const value = attributes?.[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

function normalizeUserType(value: unknown): UserType {
  return USER_TYPES.includes(value as UserType) ? value as UserType : 'staff';
}

function hasAdminGroup(groups: string[]): boolean {
  return groups.includes('Admin');
}

function userTypeFor(user: any, groups: string[]): UserType {
  return hasAdminGroup(groups) ? 'admin' : normalizeUserType(keycloakAttributeValue(user.attributes, 'bcmsUserType'));
}

function isBcmsGroup(value: string): value is BcmsGroup {
  return (BCMS_GROUPS as readonly string[]).includes(value);
}

async function setUserGroups(id: string, newGroups: string[]): Promise<void> {
  const groupIdMap = await getGroupIdMap();

  const currentKcGroups = await kcFetch<any[]>(`/users/${id}/groups`);
  const currentSet = new Set(
    currentKcGroups.map((g: any) => g.name as string).filter(isBcmsGroup),
  );
  const newSet = new Set(newGroups.filter(isBcmsGroup));

  for (const name of currentSet) {
    if (!newSet.has(name)) {
      const gid = groupIdMap.get(name);
      if (gid) await kcFetch(`/users/${id}/groups/${gid}`, { method: 'DELETE' });
    }
  }

  for (const name of newSet) {
    if (!currentSet.has(name)) {
      const gid = groupIdMap.get(name);
      if (gid) await kcFetch(`/users/${id}/groups/${gid}`, { method: 'PUT' });
    }
  }

  groupMembershipCache.delete(id);
}

async function fetchBcmsGroupMemberships(): Promise<Map<string, string[]>> {
  const groupIdMap = await getGroupIdMap();
  const memberships = new Map<string, string[]>();

  await Promise.all(BCMS_GROUPS.map(async (groupName) => {
    const groupId = groupIdMap.get(groupName);
    if (!groupId) return;

    const members = await kcFetch<any[]>(`/groups/${groupId}/members?max=500`);
    for (const member of members) {
      const groups = memberships.get(member.id) ?? [];
      groups.push(groupName);
      memberships.set(member.id, groups);
    }
  }));

  return memberships;
}

export async function usersRoutes(app: FastifyInstance) {

  // GET /api/v1/users
  app.get('/', {
    preHandler: app.requireGroup(...PERMISSIONS.auditLogs.read),
    schema: { tags: ['Users'], summary: 'Keycloak kullanıcı listesi' },
  }, async () => {
    const users = await kcFetch<any[]>('/users?max=200');
    const memberships = await fetchBcmsGroupMemberships();

    const withGroups = users.map((u) => {
      const groups = memberships.get(u.id) ?? getCachedGroups(u.id) ?? [];
      setCachedGroups(u.id, groups);
      return {
        id:        u.id,
        username:  u.username,
        email:     u.email ?? '',
        firstName: u.firstName ?? '',
        lastName:  u.lastName ?? '',
        enabled:   u.enabled ?? true,
        userType:  userTypeFor(u, groups),
        groups,
      };
    });

    // Süresi dolan cache girdilerini temizle
    for (const [id, entry] of groupMembershipCache.entries()) {
      if (Date.now() >= entry.expiresAt) groupMembershipCache.delete(id);
    }

    return withGroups.sort((a, b) => {
      if (hasAdminGroup(a.groups) && !hasAdminGroup(b.groups)) return -1;
      if (!hasAdminGroup(a.groups) && hasAdminGroup(b.groups)) return 1;
      return a.username.localeCompare(b.username, 'tr');
    });
  });

  // GET /api/v1/users/groups  — atanabilir grup listesi
  app.get('/groups', {
    preHandler: app.requireGroup(...PERMISSIONS.auditLogs.read),
    schema: { tags: ['Users'], summary: 'Atanabilir grup listesi' },
  }, async () => BCMS_GROUPS);

  // PUT /api/v1/users/:id/groups  — grupları güncelle
  app.put<{ Params: { id: string }; Body: { groups: string[] } }>('/:id/groups', {
    preHandler: app.requireGroup(...PERMISSIONS.auditLogs.read),
    schema: {
      tags: ['Users'],
      summary: 'Kullanıcı gruplarını güncelle',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body:   { type: 'object', properties: { groups: { type: 'array', items: { type: 'string' } } }, required: ['groups'] },
    },
  }, async (request) => {
    const { id } = request.params;
    const { groups: newGroups } = request.body;
    await setUserGroups(id, newGroups);
    return { ok: true };
  });

  // PUT /api/v1/users/:id — kullanıcı bilgilerini ve grupları güncelle
  app.put<{
    Params: { id: string };
    Body: {
      username: string;
      email: string;
      firstName?: string;
      lastName?: string;
      enabled: boolean;
      userType: UserType;
      groups: string[];
      password?: string;
    };
  }>('/:id', {
    preHandler: app.requireGroup(...PERMISSIONS.auditLogs.read),
    schema: {
      tags: ['Users'],
      summary: 'Kullanıcı bilgilerini güncelle',
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object',
        required: ['username', 'email', 'enabled', 'userType', 'groups'],
        properties: {
          username:  { type: 'string' },
          email:     { type: 'string' },
          firstName: { type: 'string' },
          lastName:  { type: 'string' },
          enabled:   { type: 'boolean' },
          userType:  { type: 'string', enum: [...USER_TYPES] },
          groups:    { type: 'array', items: { type: 'string' } },
          password:  { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params;
    const { username, email, firstName, lastName, enabled, userType, groups, password } = request.body;

    const existing = await kcFetch<any>(`/users/${id}`);
    const isAdmin = groups.includes('Admin');
    await kcFetch(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify({
        ...existing,
        username,
        email,
        firstName: firstName ?? '',
        lastName: lastName ?? '',
        enabled,
        attributes: {
          ...(existing.attributes ?? {}),
          bcmsUserType: [isAdmin ? 'admin' : normalizeUserType(userType)],
        },
      }),
    });

    if (password?.trim()) {
      await kcFetch(`/users/${id}/reset-password`, {
        method: 'PUT',
        body: JSON.stringify({ type: 'password', value: password, temporary: true }),
      });
    }

    await setUserGroups(id, groups);
    return { ok: true };
  });

  // PATCH /api/v1/users/:id/enabled  — aktif/pasif
  app.patch<{ Params: { id: string }; Body: { enabled: boolean } }>('/:id/enabled', {
    preHandler: app.requireGroup(...PERMISSIONS.auditLogs.read),
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
  app.post<{
    Body: { username: string; email: string; firstName?: string; lastName?: string; password: string; userType?: UserType; groups: string[] };
  }>('/', {
    preHandler: app.requireGroup(...PERMISSIONS.auditLogs.read),
    schema: {
      tags: ['Users'],
      summary: 'Yeni kullanıcı oluştur',
      body: {
        type: 'object',
        required: ['username', 'email', 'password', 'groups'],
        properties: {
          username:  { type: 'string' },
          email:     { type: 'string' },
          firstName: { type: 'string' },
          lastName:  { type: 'string' },
          password:  { type: 'string' },
          userType:  { type: 'string', enum: [...USER_TYPES] },
          groups:    { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request) => {
    const { username, email, firstName, lastName, password, groups } = request.body;
    const userType = normalizeUserType(request.body.userType);

    const url   = process.env.KEYCLOAK_URL   ?? 'http://localhost:8080';
    const realm = process.env.KEYCLOAK_REALM ?? 'bcms';
    const token = await getAdminToken();

    const createRes = await fetch(`${url}/admin/realms/${realm}/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username, email, firstName, lastName,
        enabled: true,
        attributes: { bcmsUserType: [userType] },
        credentials: [{ type: 'password', value: password, temporary: true }],
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text().catch(() => '');
      throw Object.assign(new Error(`Kullanıcı oluşturulamadı: ${text}`), { statusCode: createRes.status });
    }

    const location = createRes.headers.get('Location') ?? '';
    const newId = location.split('/').pop()!;

    // Gruplara ekle
    if (groups.length > 0) {
      const groupIdMap = await getGroupIdMap();
      for (const name of groups.filter(isBcmsGroup)) {
        const gid = groupIdMap.get(name);
        if (gid) await kcFetch(`/users/${newId}/groups/${gid}`, { method: 'PUT' });
      }
    }

    return { id: newId, username };
  });
}
