import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import jwksRsa from 'jwks-rsa';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { JwtPayload, Role } from '@bcms/shared';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireRole: (...roles: Role[]) => (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    user: JwtPayload;
  }
}

const DEV_USER: JwtPayload = {
  sub:                'dev-admin',
  preferred_username: 'dev-admin',
  email:              'dev@bcms.local',
  realm_access:       { roles: ['admin', 'planner', 'scheduler', 'ingest_operator', 'monitoring', 'viewer'] },
  resource_access:    {},
  iat: 0,
  exp: 9999999999,
};

export const authPlugin = fp(async (app: FastifyInstance) => {
  const skipAuth = process.env.SKIP_AUTH === 'true' || process.env.NODE_ENV === 'development';

  const keycloakUrl  = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
  const realm        = process.env.KEYCLOAK_REALM ?? 'bcms';
  const jwksUri      = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/certs`;

  const jwksClient = jwksRsa({ jwksUri, cache: true, rateLimit: true });

  await app.register(jwt, {
    decode: { complete: true },
    secret: (_req, token) =>
      new Promise<string>((resolve, reject) => {
        const header = (token as { header: { kid: string } }).header;
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
    app.log.warn('Auth bypass aktif — tüm istekler dev-admin olarak işleniyor');
  }

  // ── Decorators ──────────────────────────────────────────────────────────────
  app.decorate('authenticate', async (request: FastifyRequest) => {
    if (skipAuth && !request.headers.authorization) {
      request.user = DEV_USER;
      return;
    }
    try {
      await request.jwtVerify();
    } catch {
      throw app.httpErrors?.unauthorized('Invalid or expired token') ??
        Object.assign(new Error('Unauthorized'), { statusCode: 401 });
    }
  });

  app.decorate('requireRole', (...roles: Role[]) => async (request: FastifyRequest) => {
    await app.authenticate(request);
    const userRoles: string[] = request.user?.realm_access?.roles ?? [];
    const hasRole = roles.some((r) => userRoles.includes(r));
    if (!hasRole) {
      const err = Object.assign(new Error('Insufficient permissions'), { statusCode: 403 });
      throw err;
    }
  });
});
