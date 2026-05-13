import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';
import { prismaPlugin } from '../../plugins/prisma.js';
import { optaRoutes } from './opta.routes.js';

/**
 * 2026-05-13: OPTA lig görünürlük yönetimi integration spec.
 *
 * Kapsam:
 *   ✓ GET /fixture-competitions sadece visible=true ligleri döner
 *   ✓ visible=false lig dropdown'da görünmez
 *   ✓ sortOrder asc + name fallback sıralama
 *   ✓ GET /competitions/admin tüm ligleri döner (visible + hidden)
 *   ✓ PATCH /competitions/admin/:id visible toggle
 *   ✓ PATCH /competitions/admin/:id sortOrder güncelle
 *   ✓ PATCH body boş → 400 (Zod refine)
 *   ✓ PATCH non-existent id → 404
 *
 * Auth: test app `requireGroup` mock — Admin/SystemEng paterni production'da
 * geçerli; spec scope auth bypass (test app harness).
 */

const PREFIX = '/api/v1/opta';

describe('OPTA competitions admin — 2026-05-13', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    app.decorate('requireGroup', () => async () => undefined);
    app.setErrorHandler((error, _req, reply) => {
      if (error instanceof ZodError) {
        return reply.status(400).send({ statusCode: 400, error: 'Bad Request', issues: error.issues });
      }
      const status = (error as { statusCode?: number }).statusCode ?? 500;
      return reply.status(status).send({ statusCode: status, error: error.message });
    });
    await app.register(optaRoutes, { prefix: PREFIX });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupTransactional();
  });

  async function seedLeagues() {
    const prisma = getRawPrisma();
    // 3 lig: 2 visible (sortOrder 1, 2), 1 hidden.
    // League id=1 seed 'Süper Lig' visible default false (seed eski; testte
    // explicit visible=true).
    await prisma.league.update({
      where: { id: 1 },
      data:  { visible: true, sortOrder: 1, name: 'Süper Lig (visible)' },
    });
    const lig2 = await prisma.league.upsert({
      where:  { code: 'opta-test-2' },
      update: { visible: true, sortOrder: 2 },
      create: { id: 9001, code: 'opta-test-2', name: 'Premier (visible)', country: 'EN', visible: true, sortOrder: 2 },
    });
    const ligH = await prisma.league.upsert({
      where:  { code: 'opta-test-hidden' },
      update: { visible: false, sortOrder: 99 },
      create: { id: 9002, code: 'opta-test-hidden', name: 'Hidden Lig', country: 'XX', visible: false, sortOrder: 99 },
    });
    return { ligSL: 1, lig2: lig2.id, ligH: ligH.id };
  }

  // ── /fixture-competitions (visible filter) ─────────────────────────────
  test('GET /fixture-competitions: yalnız visible=true ligler döner', async () => {
    await seedLeagues();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/fixture-competitions` });
    expect(res.statusCode).toBe(200);
    const items = res.json() as { id: string; name: string; season: string }[];
    const names = items.map((i) => i.name);
    expect(names).toContain('Süper Lig (visible)');
    expect(names).toContain('Premier (visible)');
    expect(names).not.toContain('Hidden Lig');
  });

  test('GET /fixture-competitions: sortOrder asc + name fallback', async () => {
    const prisma = getRawPrisma();
    await prisma.league.update({ where: { id: 1 }, data: { visible: true, sortOrder: 5, name: 'Zeta Lig' } });
    await prisma.league.upsert({
      where:  { code: 'opta-alpha' },
      update: { visible: true, sortOrder: 1, name: 'Alpha Lig' },
      create: { id: 9003, code: 'opta-alpha', name: 'Alpha Lig', country: 'X', visible: true, sortOrder: 1 },
    });
    await prisma.league.upsert({
      where:  { code: 'opta-beta' },
      update: { visible: true, sortOrder: 1, name: 'Beta Lig' },
      create: { id: 9004, code: 'opta-beta', name: 'Beta Lig', country: 'X', visible: true, sortOrder: 1 },
    });
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/fixture-competitions` });
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { name: string }[]).map((i) => i.name);
    // sortOrder asc: 1 (Alpha, Beta — tr-TR name asc) → 5 (Zeta)
    expect(names.indexOf('Alpha Lig')).toBeLessThan(names.indexOf('Beta Lig'));
    expect(names.indexOf('Beta Lig')).toBeLessThan(names.indexOf('Zeta Lig'));
  });

  // ── /competitions/admin GET ────────────────────────────────────────────
  test('GET /competitions/admin: tüm ligleri döner (visible + hidden)', async () => {
    await seedLeagues();
    const res = await app.inject({ method: 'GET', url: `${PREFIX}/competitions/admin` });
    expect(res.statusCode).toBe(200);
    const items = res.json() as { code: string; visible: boolean }[];
    const codes = items.map((i) => i.code);
    expect(codes).toContain('opta-test-2');
    expect(codes).toContain('opta-test-hidden');
    const hidden = items.find((i) => i.code === 'opta-test-hidden');
    expect(hidden?.visible).toBe(false);
  });

  // ── /competitions/admin PATCH ──────────────────────────────────────────
  test('PATCH /competitions/admin/:id visible toggle → fixture dropdown\'dan düşer', async () => {
    const { lig2 } = await seedLeagues();
    // Önce visible
    const before = await app.inject({ method: 'GET', url: `${PREFIX}/fixture-competitions` });
    const namesBefore = (before.json() as { name: string }[]).map((i) => i.name);
    expect(namesBefore).toContain('Premier (visible)');

    // Hide
    const patch = await app.inject({
      method: 'PATCH', url: `${PREFIX}/competitions/admin/${lig2}`,
      payload: { visible: false },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { visible: boolean }).visible).toBe(false);

    // Sonra fixture-competitions düşmüş
    const after = await app.inject({ method: 'GET', url: `${PREFIX}/fixture-competitions` });
    const namesAfter = (after.json() as { name: string }[]).map((i) => i.name);
    expect(namesAfter).not.toContain('Premier (visible)');
  });

  test('PATCH /competitions/admin/:id sortOrder güncelle', async () => {
    const { ligSL } = await seedLeagues();
    const patch = await app.inject({
      method: 'PATCH', url: `${PREFIX}/competitions/admin/${ligSL}`,
      payload: { sortOrder: 42 },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { sortOrder: number }).sortOrder).toBe(42);
  });

  test('PATCH /competitions/admin/:id body boş → 400 (Zod refine)', async () => {
    const { ligSL } = await seedLeagues();
    const res = await app.inject({
      method: 'PATCH', url: `${PREFIX}/competitions/admin/${ligSL}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  test('PATCH /competitions/admin/:id non-existent id → 404', async () => {
    const res = await app.inject({
      method: 'PATCH', url: `${PREFIX}/competitions/admin/999999`,
      payload: { visible: true },
    });
    expect(res.statusCode).toBe(404);
  });

  test('PATCH sortOrder negatif → 400 (Zod nonnegative)', async () => {
    const { ligSL } = await seedLeagues();
    const res = await app.inject({
      method: 'PATCH', url: `${PREFIX}/competitions/admin/${ligSL}`,
      payload: { sortOrder: -1 },
    });
    expect(res.statusCode).toBe(400);
  });
});
