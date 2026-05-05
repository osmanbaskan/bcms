import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ScheduleService } from './schedule.service.js';
import {
  cleanupTransactional,
  getRawPrisma,
  makeAppHarness,
  makeRequest,
  makeUser,
  type TestAppHarness,
} from '../../../test/integration/helpers.js';

/**
 * Schedule service integration spec — Madde 8 spec 2 (booking spec a45ee74'ten sonra).
 *
 * Kapsam (REQUIREMENTS-BACKEND-INTEGRATION-TESTS.md §3 Spec 2'nin dar alt-kümesi):
 *   ✓ create: kanal çakışması → 409 + sanitizeConflicts (count + IDs + window;
 *     title/status sızmaz — ÖNEMLİ-API-1.2.7 regression)
 *   ✓ create live-plan (channelId=null): GiST bypass; conflict check yok, başarılı
 *   ✓ update If-Match version uyumlu: ok + version increment
 *   ✓ update If-Match version stale: 412
 *   ✓ update time change kanal çakışması: 409
 *   ✓ usageScope filter: findAll({ usage: 'live-plan' }) sadece live-plan döndürür
 *
 * Out of scope (sonraki PR):
 *   - Serializable retry P2034 simülasyonu (DB-level injection gerek)
 *   - remove() hard delete + FK cascade davranışı
 */

describe('ScheduleService — integration', () => {
  let harness: TestAppHarness;
  let svc: ScheduleService;

  // Future date — testlerin sabit referans alması için.
  const baseDate = new Date('2026-08-15T10:00:00.000Z');
  const isoStart = baseDate.toISOString();
  const isoEnd = new Date(baseDate.getTime() + 90 * 60 * 1000).toISOString(); // +1.5h

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new ScheduleService(harness.app as unknown as FastifyInstance);
  });

  afterEach(async () => {
    /* per-test cleanup beforeEach'te */
  });

  // ── create: conflict + sanitizeConflicts ─────────────────────────────────

  test('create: kanal çakışması → 409 + sanitizeConflicts payload (title/status sızmaz)', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    // Önce bir schedule oluştur (channel 1, 10:00-11:30 UTC).
    const first = await svc.create(
      {
        channelId: 1,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Mevcut yayın — başlık sızmamalı',
        usageScope: 'broadcast',
      },
      req,
    );
    expect(first.id).toBeGreaterThan(0);

    // Aynı kanalda örtüşen zaman aralığı: çakışma beklenir.
    let caught: unknown;
    try {
      await svc.create(
        {
          channelId: 1,
          startTime: new Date(baseDate.getTime() + 30 * 60 * 1000).toISOString(), // +30m içinde
          endTime: new Date(baseDate.getTime() + 60 * 60 * 1000).toISOString(),
          title: 'Çakışan yeni',
          usageScope: 'broadcast',
        },
        req,
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeDefined();
    const err = caught as { statusCode?: number; conflicts?: unknown };
    expect(err.statusCode).toBe(409);

    // sanitizeConflicts shape: count + conflictIds + timeWindow.
    // title/status field'ları payload'da OLMAMALI (info disclosure önlemi).
    expect(err.conflicts).toMatchObject({
      count: 1,
      conflictIds: [first.id],
    });
    const conflicts = err.conflicts as { count: number; conflictIds: number[]; timeWindow: unknown };
    expect(conflicts.timeWindow).toBeTruthy();
    // Defansif: stringify edip arama yap, title/status sızmamalı.
    const serialized = JSON.stringify(err.conflicts);
    expect(serialized).not.toContain('Mevcut yayın');
    expect(serialized).not.toMatch(/\bDRAFT\b|\bCONFIRMED\b|\bON_AIR\b/);
  });

  // ── create: live-plan (channelId=null) bypass ────────────────────────────

  test('create: live-plan (channelId=null) GiST bypass — overlap toleranslı', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const first = await svc.create(
      {
        channelId: null,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Live plan #1',
        usageScope: 'live-plan',
      },
      req,
    );
    expect(first.id).toBeGreaterThan(0);
    expect(first.channelId).toBeNull();
    expect(first.usageScope).toBe('live-plan');

    // Aynı zaman aralığı için ikinci live-plan: conflict check atlanır → başarılı.
    const second = await svc.create(
      {
        channelId: null,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Live plan #2 aynı saat',
        usageScope: 'live-plan',
      },
      req,
    );
    expect(second.id).toBeGreaterThan(first.id);
  });

  // ── update: optimistic locking ─────────────────────────────────────────────

  test('update: If-Match version uyumlu → ok + version increment', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      { channelId: 1, startTime: isoStart, endTime: isoEnd, title: 'Initial', usageScope: 'broadcast' },
      req,
    );
    const initialVersion = created.version;

    const updated = await svc.update(
      created.id,
      { title: 'Updated' },
      initialVersion,
      req,
    );
    expect(updated.title).toBe('Updated');
    expect(updated.version).toBe(initialVersion + 1);
  });

  test('update: If-Match version stale → 412', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      { channelId: 1, startTime: isoStart, endTime: isoEnd, title: 'Initial', usageScope: 'broadcast' },
      req,
    );
    const staleVersion = created.version - 1;

    await expect(
      svc.update(created.id, { title: 'New' }, staleVersion, req),
    ).rejects.toMatchObject({ statusCode: 412 });
  });

  // ── update: time change conflict ──────────────────────────────────────────

  test('update: time değişikliği başka schedule ile çakışıyorsa → 409', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    // İki schedule farklı zaman dilimlerinde.
    const a = await svc.create(
      { channelId: 1, startTime: isoStart, endTime: isoEnd, title: 'A', usageScope: 'broadcast' },
      req,
    );
    const bStart = new Date(baseDate.getTime() + 3 * 60 * 60 * 1000).toISOString(); // +3h
    const bEnd = new Date(baseDate.getTime() + 4 * 60 * 60 * 1000).toISOString();
    const b = await svc.create(
      { channelId: 1, startTime: bStart, endTime: bEnd, title: 'B', usageScope: 'broadcast' },
      req,
    );

    // B'yi A ile çakışacak zaman aralığına çekmeye çalış.
    const overlapStart = new Date(baseDate.getTime() + 30 * 60 * 1000).toISOString();
    const overlapEnd = new Date(baseDate.getTime() + 60 * 60 * 1000).toISOString();

    let caught: unknown;
    try {
      await svc.update(b.id, { startTime: overlapStart, endTime: overlapEnd }, b.version, req);
    } catch (e) {
      caught = e;
    }
    const err = caught as { statusCode?: number; conflicts?: { count: number; conflictIds: number[] } };
    expect(err.statusCode).toBe(409);
    expect(err.conflicts?.conflictIds).toContain(a.id);
  });

  // ── usageScope filter ────────────────────────────────────────────────────

  test('findAll: usage=live-plan filter sadece live-plan kayıtları döndürür', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    // 2 broadcast + 1 live-plan
    await svc.create(
      { channelId: 1, startTime: isoStart, endTime: isoEnd, title: 'Broadcast A', usageScope: 'broadcast' },
      req,
    );
    const farStart = new Date(baseDate.getTime() + 5 * 60 * 60 * 1000).toISOString();
    const farEnd = new Date(baseDate.getTime() + 6 * 60 * 60 * 1000).toISOString();
    await svc.create(
      { channelId: 2, startTime: farStart, endTime: farEnd, title: 'Broadcast B', usageScope: 'broadcast' },
      req,
    );
    await svc.create(
      { channelId: null, startTime: isoStart, endTime: isoEnd, title: 'Live X', usageScope: 'live-plan' },
      req,
    );

    const livePlanResult = await svc.findAll({
      usage: 'live-plan',
      page: 1,
      pageSize: 50,
    });

    expect(livePlanResult.total).toBe(1);
    expect(livePlanResult.data).toHaveLength(1);
    expect(livePlanResult.data[0].title).toBe('Live X');
    expect(livePlanResult.data[0].usageScope).toBe('live-plan');

    const broadcastResult = await svc.findAll({
      usage: 'broadcast',
      page: 1,
      pageSize: 50,
    });
    expect(broadcastResult.total).toBe(2);
    expect(broadcastResult.data.every((s) => s.usageScope === 'broadcast')).toBe(true);
  });
});

// suppress unused import lint if any
void getRawPrisma;
