import { beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { LookupService } from './lookup.service.js';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * Madde 5 M5-B5 spec — Lookup management service.
 *
 * Tasarım: REQUIREMENTS-LIVE-PLAN-TECHNICAL-FIELDS-V1.md §6 + L1-L12 lock.
 *
 * Auth scope: testler service'i doğrudan çağırır; route handler RBAC
 * (`livePlanLookups.read/write/delete`) bu testten kapsam dışı (booking pattern).
 */

describe('LookupService — integration', () => {
  let harness: TestAppHarness;
  let svc: LookupService;

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new LookupService(harness.app as unknown as FastifyInstance);
  });

  // ── Create + List ───────────────────────────────────────────────────────────

  test('create non-polymorphic + list default order (active DESC, sortOrder ASC, label ASC)', async () => {
    await svc.create('transmission_irds', { label: 'IRD - Z', sortOrder: 100 });
    await svc.create('transmission_irds', { label: 'IRD - A', sortOrder: 50 });
    const inactive = await svc.create('transmission_irds', { label: 'IRD - INACTIVE', active: false });
    void inactive;

    const result = await svc.list('transmission_irds', {
      activeOnly:     false, // inactive dahil et
      includeDeleted: false,
      page: 1, pageSize: 50,
    });

    expect(result.total).toBe(3);
    // L9: active DESC → aktifler önce; sonra sortOrder ASC; sonra label ASC.
    // Aktif 2: ('IRD - A' sortOrder=50) önce, ('IRD - Z' sortOrder=100) sonra.
    // Inactive en sonda.
    expect(result.items.map((r) => r.label)).toEqual(['IRD - A', 'IRD - Z', 'IRD - INACTIVE']);
  });

  test('create polymorphic technical_companies with required type', async () => {
    const ob = await svc.create('technical_companies', { label: 'AcmeCo', type: 'OB_VAN' });
    expect(ob.label).toBe('AcmeCo');
    expect(ob.type).toBe('OB_VAN');
    expect(ob.active).toBe(true);
  });

  test('create polymorphic without type → 400', async () => {
    await expect(
      svc.create('technical_companies', { label: 'NoType' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('create polymorphic with invalid type → 400', async () => {
    await expect(
      svc.create('technical_companies', { label: 'Bad', type: 'NOT_A_REAL_TYPE' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('create non-polymorphic with type → 400 (type yalnız polymorphic için)', async () => {
    await expect(
      svc.create('transmission_irds', { label: 'X', type: 'OB_VAN' }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('create duplicate (case-insensitive) → 409 (unique violation handled)', async () => {
    await svc.create('transmission_irds', { label: 'IRD - DUP' });
    await expect(
      svc.create('transmission_irds', { label: 'ird - dup' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // ── List filter ────────────────────────────────────────────────────────────

  test('list activeOnly=true (default) → inactive hariç', async () => {
    await svc.create('transmission_irds', { label: 'A', active: true });
    await svc.create('transmission_irds', { label: 'B', active: false });

    const result = await svc.list('transmission_irds', {
      activeOnly:     true,
      includeDeleted: false,
      page: 1, pageSize: 50,
    });
    expect(result.total).toBe(1);
    expect(result.items[0].label).toBe('A');
  });

  test('list polymorphic with type filter → sadece eşleşen type', async () => {
    await svc.create('technical_companies', { label: 'OBCo', type: 'OB_VAN' });
    await svc.create('technical_companies', { label: 'GenCo', type: 'GENERATOR' });

    const result = await svc.list('technical_companies', {
      activeOnly:     true,
      includeDeleted: false,
      type:           'OB_VAN',
      page: 1, pageSize: 50,
    });
    expect(result.total).toBe(1);
    expect(result.items[0].label).toBe('OBCo');
  });

  test('list polymorphic with invalid type filter → 400', async () => {
    await expect(
      svc.list('technical_companies', {
        activeOnly:     true,
        includeDeleted: false,
        type:           'INVALID',
        page: 1, pageSize: 50,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // ── getById ────────────────────────────────────────────────────────────────

  test('getById not found → 404', async () => {
    await expect(svc.getById('transmission_irds', 999_999))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  // ── Update (PATCH) ─────────────────────────────────────────────────────────

  test('update label + sortOrder', async () => {
    const c = await svc.create('transmission_irds', { label: 'Original', sortOrder: 10 });
    const u = await svc.update('transmission_irds', c.id, { label: 'Updated', sortOrder: 99 });
    expect(u.label).toBe('Updated');
    expect(u.sortOrder).toBe(99);
  });

  test('update active toggle', async () => {
    const c = await svc.create('transmission_irds', { label: 'Toggle' });
    const u = await svc.update('transmission_irds', c.id, { active: false });
    expect(u.active).toBe(false);
  });

  test('update with deletedAt non-null (Date) → 400 (L10)', async () => {
    const c = await svc.create('transmission_irds', { label: 'X' });
    await expect(
      svc.update('transmission_irds', c.id, { deletedAt: new Date() as unknown as null }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test('update not found → 404', async () => {
    await expect(
      svc.update('transmission_irds', 999_999, { label: 'X' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── Soft Delete + Restore ──────────────────────────────────────────────────

  test('softDelete: deletedAt + active=false (atomic)', async () => {
    const c = await svc.create('transmission_irds', { label: 'ToDelete', active: true });
    const d = await svc.softDelete('transmission_irds', c.id);
    expect(d.deletedAt).not.toBeNull();
    expect(d.active).toBe(false);
  });

  test('softDelete idempotent: already soft-deleted → no-op', async () => {
    const c = await svc.create('transmission_irds', { label: 'Idempotent' });
    const d1 = await svc.softDelete('transmission_irds', c.id);
    const d2 = await svc.softDelete('transmission_irds', c.id);
    expect(d2.id).toBe(d1.id);
    expect(d2.deletedAt).toEqual(d1.deletedAt);
  });

  test('restore via update deletedAt:null', async () => {
    const c = await svc.create('transmission_irds', { label: 'ToRestore' });
    await svc.softDelete('transmission_irds', c.id);

    const restored = await svc.update('transmission_irds', c.id, { deletedAt: null });
    expect(restored.deletedAt).toBeNull();
    // Active state restore'da değişmez (L5 alt-karar): silinen kayıt active=false idi,
    // restore deletedAt'i null'a çeker, active hâlâ false. Operatör ayrıca PATCH
    // active=true yapabilir.
    expect(restored.active).toBe(false);
  });

  test('partial unique respects soft delete: aynı label silinmiş + yeni eklenebilir', async () => {
    const a = await svc.create('transmission_irds', { label: 'IRD - SOFT' });
    await svc.softDelete('transmission_irds', a.id);

    // Aynı label ile yeni create OK (partial unique deleted_at IS NULL exclude)
    const b = await svc.create('transmission_irds', { label: 'IRD - SOFT' });
    expect(b.id).not.toBe(a.id);
    expect(b.deletedAt).toBeNull();

    // İki tane satır var (biri silinmiş, biri aktif).
    const prisma = getRawPrisma();
    const all = await prisma.transmissionIrd.findMany({
      where: { label: 'IRD - SOFT' },
    });
    expect(all).toHaveLength(2);
  });

  // ── List with includeDeleted (service-level; route'ta RBAC kontrolü ayrı) ─

  test('list includeDeleted=true → soft-deleted dahil', async () => {
    const a = await svc.create('transmission_irds', { label: 'Live' });
    const b = await svc.create('transmission_irds', { label: 'Dead' });
    await svc.softDelete('transmission_irds', b.id);
    void a;

    // includeDeleted=true (route'ta RBAC kontrolü; service direkt)
    const withDeleted = await svc.list('transmission_irds', {
      activeOnly:     false,
      includeDeleted: true,
      page: 1, pageSize: 50,
    });
    expect(withDeleted.total).toBe(2);

    const withoutDeleted = await svc.list('transmission_irds', {
      activeOnly:     false,
      includeDeleted: false,
      page: 1, pageSize: 50,
    });
    expect(withoutDeleted.total).toBe(1);
    expect(withoutDeleted.items[0].label).toBe('Live');
  });

  // ── Polymorphic same label different type ─────────────────────────────────

  test('polymorphic: aynı label farklı type ile çakışmaz', async () => {
    await svc.create('technical_companies', { label: 'SharedName', type: 'OB_VAN' });
    const second = await svc.create('technical_companies', { label: 'SharedName', type: 'GENERATOR' });
    expect(second.type).toBe('GENERATOR');
  });

  test('polymorphic: aynı label aynı type → 409', async () => {
    await svc.create('technical_companies', { label: 'DupCo', type: 'OB_VAN' });
    await expect(
      svc.create('technical_companies', { label: 'dupco', type: 'OB_VAN' }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
