import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import jwksRsa from 'jwks-rsa';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload, BcmsGroup } from '@bcms/shared';

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

const DEV_USER: JwtPayload = {
  sub:                'dev-admin',
  preferred_username: 'dev-admin',
  email:              'dev@bcms.local',
  groups:             ['SystemEng'],
  iat: 0,
  exp: 9999999999,
};

type TokenClaims = JwtPayload & {
  iss?: string;
  aud?: string | string[];
  azp?: string;
};

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
    } catch {
      throw Object.assign(new Error('Invalid or expired token'), { statusCode: 401 });
    }
  });

  app.decorate('requireGroup', (...groups: BcmsGroup[]) => async (request: FastifyRequest) => {
    await app.authenticate(request);
    const userGroups: string[] = (request.user as JwtPayload)?.groups ?? [];
    const hasGroup = groups.some((g) => userGroups.includes(g));
    if (!hasGroup) {
      throw Object.assign(new Error('Insufficient permissions'), { statusCode: 403 });
    }
  });
});
