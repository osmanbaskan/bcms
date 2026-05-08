import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';
import { prismaPlugin } from '../../plugins/prisma.js';
import { scheduleLookupRoutes } from './schedule-lookup.routes.js';

/**
 * SCHED-B4-prep spec — schedule broadcast lookup read-only endpoints.
 *
 * Kapsam:
 *   ✓ GET /:type whitelist (commercial_options/logo_options/format_options)
 *   ✓ Bilinmeyen type → 404
 *   ✓ activeOnly=true filtre
 *   ✓ Soft-deleted satır default exclude
 *   ✓ sortOrder + id ASC sıralama
 */

describe('schedule lookup read-only endpoints — SCHED-B4-prep', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    // RBAC bypass için minimal: requireGroup decorator boş whitelist all-auth;
    // PERMISSIONS.scheduleLookups.read = []. Yine de auth bypass için decorate.
    app.decorate('requireGroup', () => async () => undefined);
    await app.register(scheduleLookupRoutes, { prefix: '/api/v1/schedules/lookups' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanupTransactional();
  });

  test('whitelist: bilinmeyen type → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/schedules/lookups/bogus' });
    expect(res.statusCode).toBe(404);
  });

  test('commercial_options: list aktif/inaktif + sortOrder ASC', async () => {
    const prisma = getRawPrisma();
    await prisma.scheduleCommercialOption.createMany({
      data: [
        { label: 'Reklam A', sortOrder: 2 },
        { label: 'Reklam B', sortOrder: 1 },
        { label: 'Reklam C', sortOrder: 3, active: false },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/schedules/lookups/commercial_options' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ label: string; active: boolean; sortOrder: number }> };
    expect(body.items.map((i) => i.label)).toEqual(['Reklam B', 'Reklam A', 'Reklam C']);
  });

  test('activeOnly=true → sadece aktif satırlar', async () => {
    const prisma = getRawPrisma();
    await prisma.scheduleLogoOption.createMany({
      data: [
        { label: 'Logo X', active: true,  sortOrder: 1 },
        { label: 'Logo Y', active: false, sortOrder: 2 },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url:    '/api/v1/schedules/lookups/logo_options?activeOnly=true',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ label: string }> };
    expect(body.items.map((i) => i.label)).toEqual(['Logo X']);
  });

  test('soft-deleted satır default exclude', async () => {
    const prisma = getRawPrisma();
    await prisma.scheduleFormatOption.createMany({
      data: [
        { label: 'Format 1', sortOrder: 1 },
        { label: 'Format 2', sortOrder: 2, deletedAt: new Date() },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/schedules/lookups/format_options' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ label: string }> };
    expect(body.items.map((i) => i.label)).toEqual(['Format 1']);
  });

  test('format_options: 3 lookup tablo whitelist çalışıyor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/schedules/lookups/format_options' });
    expect(res.statusCode).toBe(200);
  });
});
