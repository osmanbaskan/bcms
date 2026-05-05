import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import jwksRsa from 'jwks-rsa';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GROUP, type JwtPayload, type BcmsGroup } from '@bcms/shared';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    user: JwtPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireGroup: (...groups: BcmsGroup[]) => (request: FastifyRequest) => Promise<void>;
  }
}

// ORTA-API-1.1.10 fix (2026-05-04): DEV_USER groups env override.
// Eski hâl: hardcoded [SystemEng] → "SystemEng dışı bir grup" senaryosunu
// simulate edemiyordu (smoke testte yetki testi yapan biri için handicap).
// DEV_USER_GROUPS env'i CSV (örn. "Admin,Tekyon") ile override edilebilir;
// set edilmemişse default [SystemEng].
function buildDevUser(): JwtPayload {
  const raw = process.env.DEV_USER_GROUPS?.trim();
  const groups = raw
    ? raw.split(',').map((g) => g.trim()).filter(Boolean)
    : [GROUP.SystemEng];
  return {
    sub:                process.env.DEV_USER_SUB ?? 'dev-admin',
    preferred_username: process.env.DEV_USER_NAME ?? 'dev-admin',
    email:              process.env.DEV_USER_EMAIL ?? 'dev@bcms.local',
    groups,
    iat: 0,
    exp: 9999999999,
  };
}
const DEV_USER: JwtPayload = buildDevUser();

type TokenClaims = JwtPayload & {
  iss?: string;
  aud?: string | string[];
  azp?: string;
};

// LOW-API-009 fix (2026-05-05): 'Admin' literal yerine GROUP.Admin (CLAUDE.md
// "no hardcoded group strings").
function isAdminPrincipal(claims: Pick<JwtPayload, 'groups'>): boolean {
  return claims.groups?.includes(GROUP.Admin) ?? false;
}

function hasAudience(claims: TokenClaims, clientIds: string[]): boolean {
  const aud = claims.aud;
  return clientIds.some((clientId) => (
    claims.azp === clientId || (Array.isArray(aud) ? aud.includes(clientId) : aud === clientId)
  ));
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  const skipAuth = process.env.SKIP_AUTH === 'true';

  if (process.env.NODE_ENV === 'production' && skipAuth) {
    throw new Error('SKIP_AUTH cannot be enabled in production');
  }

  const keycloakUrl  = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
  const realm        = process.env.KEYCLOAK_REALM ?? 'bcms';
  const clientId     = process.env.KEYCLOAK_CLIENT_ID ?? 'bcms-web';
  const primaryIssuer = process.env.KEYCLOAK_ISSUER ?? `${keycloakUrl}/realms/${realm}`;
  const allowedIssuers = (process.env.KEYCLOAK_ALLOWED_ISSUERS ?? primaryIssuer)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const clientIds    = (process.env.KEYCLOAK_ALLOWED_CLIENTS ?? clientId)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const jwksUri      = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/certs`;

  const jwksClient = jwksRsa({ jwksUri, cache: true, rateLimit: true });

  // ÖNEMLİ-API-1.1.9 fix (2026-05-04): JWKS fetch failure için 503 ayrımı.
  // Eski hâlinde herhangi bir hata 401'e dönüyordu — Keycloak down ise
  // kullanıcı sürekli /login redirect'iyle infrastructure problemini
  // maskeliyordu. JWKS-spesifik hatalar 503 (Service Unavailable),
  // gerçek invalid/expired token 401 olarak ayrıştırılıyor.
  type JwksLikeError = { code?: string; name?: string; message?: string };
  function isJwksInfrastructureError(err: unknown): boolean {
    const e = err as JwksLikeError;
    if (!e || typeof e !== 'object') return false;
    if (e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' || e.code === 'ETIMEDOUT') return true;
    if (e.code === 'EAI_AGAIN' || e.code === 'ECONNRESET') return true;
    if (e.name === 'JwksError' || e.name === 'JwksRateLimitError') return true;
    const msg = e.message ?? '';
    return msg.includes('jwks') || msg.includes('No signing key');
  }

  await app.register(jwt, {
    decode: { complete: true },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    secret: (_req: FastifyRequest, token: any) =>
      new Promise<string>((resolve, reject) => {
        const header = token.header as { kid: string };
        jwksClient.getSigningKey(header.kid, (err, key) => {
          if (err || !key) return reject(err ?? new Error('No signing key found'));
          resolve(key.getPublicKey());
        });
      }),
    verify: {
      algorithms: ['RS256'],
    },
  });

  if (skipAuth) {
    app.log.warn('Auth bypass aktif — tüm istekler dev-admin (SystemEng) olarak işleniyor');
  }

  // ── Decorators ──────────────────────────────────────────────────────────────
  app.decorate('authenticate', async (request: FastifyRequest) => {
    if (skipAuth && !request.headers.authorization) {
      request.user = DEV_USER;
      return;
    }
    try {
      await request.jwtVerify();
      const claims = request.user as TokenClaims;
      if (!allowedIssuers.includes(claims.iss ?? '') || !hasAudience(claims, clientIds)) {
        throw new Error('Invalid token issuer or client');
      }
      // 2026-05-01: Admin → SystemEng auto-augment kaldırıldı.
      // Admin tam yetkisi requireGroup içindeki isAdminPrincipal early return
      // ile sağlanıyor (line ~112). Augment "Admin = ops super-grup" eski
      // modelin kalıntısıydı; yeni RBAC ile çakışıyordu.
    } catch (err) {
      if (isJwksInfrastructureError(err)) {
        app.log.error({ err }, 'JWKS fetch/Keycloak unreachable — 503 dönülüyor');
        throw Object.assign(new Error('Authentication service unavailable'), { statusCode: 503 });
      }
      throw Object.assign(new Error('Invalid or expired token'), { statusCode: 401 });
    }
  });

  app.decorate('requireGroup', (...groups: BcmsGroup[]) => async (request: FastifyRequest) => {
    await app.authenticate(request);
    if (groups.length === 0) return; // no group restriction — any authenticated user
    if (isAdminPrincipal(request.user as JwtPayload)) return;
    const userGroups: string[] = (request.user as JwtPayload)?.groups ?? [];
    const hasGroup = groups.some((g) => userGroups.includes(g));
    if (!hasGroup) {
      throw Object.assign(new Error('Insufficient permissions'), { statusCode: 403 });
    }
  });
});
