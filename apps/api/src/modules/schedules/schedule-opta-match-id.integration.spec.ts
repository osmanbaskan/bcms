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
 * Schedule optaMatchId kolon promote — Madde 3 PR-3A regression spec.
 *
 * Doğrulanan davranışlar:
 *   ✓ create: dto.optaMatchId → kolon + metadata.optaMatchId paralel yazılır
 *   ✓ create: legacy caller (sadece metadata.optaMatchId) → kolona da yazar (transition)
 *   ✓ update: undefined → kolon + metadata dokunulmaz
 *   ✓ update: null → kolon NULL + metadata.optaMatchId key'i kaldırılır
 *   ✓ update: string → kolon set + metadata.optaMatchId paralel set
 *   ✓ Non-unique index: aynı optaMatchId iki ayrı schedule'da kabul (multi-channel)
 */

describe('Schedule optaMatchId — integration', () => {
  let harness: TestAppHarness;
  let svc: ScheduleService;

  const isoStart = '2026-09-01T10:00:00.000Z';
  const isoEnd   = '2026-09-01T11:30:00.000Z';

  beforeEach(async () => {
    await cleanupTransactional();
    harness = makeAppHarness();
    svc = new ScheduleService(harness.app as unknown as FastifyInstance);
  });

  afterEach(() => { /* per-test cleanup beforeEach'te */ });

  // ── create dual-write ────────────────────────────────────────────────────

  test('create: dto.optaMatchId → kolon + metadata.optaMatchId paralel', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        channelId: 1,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'OPTA match dual-write',
        usageScope: 'broadcast',
        optaMatchId: 'g123456',
      },
      req,
    );

    expect(created.optaMatchId).toBe('g123456');
    const meta = created.metadata as Record<string, unknown> | null;
    expect(meta?.optaMatchId).toBe('g123456');
  });

  test('create: legacy caller (sadece metadata.optaMatchId) → kolona da promote edilir', async () => {
    const user = makeUser({ username: 'legacy', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        channelId: 1,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Legacy metadata-only caller',
        usageScope: 'broadcast',
        metadata: { optaMatchId: 'g999', source: 'legacy' },
      },
      req,
    );

    expect(created.optaMatchId).toBe('g999');
    const meta = created.metadata as Record<string, unknown>;
    expect(meta.optaMatchId).toBe('g999');
    expect(meta.source).toBe('legacy');
  });

  // ── update 3-state semantik ──────────────────────────────────────────────

  test('update: optaMatchId undefined → kolon ve metadata aynen kalır', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        channelId: 1,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Initial',
        usageScope: 'broadcast',
        optaMatchId: 'g111',
      },
      req,
    );

    const updated = await svc.update(
      created.id,
      { title: 'Title changed only' },
      created.version,
      req,
    );

    expect(updated.optaMatchId).toBe('g111');
    const meta = updated.metadata as Record<string, unknown> | null;
    expect(meta?.optaMatchId).toBe('g111');
  });

  test('update: optaMatchId null → kolon temizle + metadata key kaldır', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        channelId: 1,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Initial',
        usageScope: 'broadcast',
        optaMatchId: 'g222',
        metadata: { optaMatchId: 'g222', extra: 'kalmali' },
      },
      req,
    );

    const updated = await svc.update(
      created.id,
      { optaMatchId: null },
      created.version,
      req,
    );

    expect(updated.optaMatchId).toBeNull();
    const meta = updated.metadata as Record<string, unknown> | null;
    expect(meta).toBeTruthy();
    expect((meta as Record<string, unknown>).optaMatchId).toBeUndefined();
    // Diğer metadata field'ları korunmalı
    expect((meta as Record<string, unknown>).extra).toBe('kalmali');
  });

  test('update: optaMatchId string → kolon set + metadata.optaMatchId paralel set', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const created = await svc.create(
      {
        channelId: 1,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Initial without opta',
        usageScope: 'broadcast',
      },
      req,
    );
    expect(created.optaMatchId).toBeNull();

    const updated = await svc.update(
      created.id,
      { optaMatchId: 'g333' },
      created.version,
      req,
    );

    expect(updated.optaMatchId).toBe('g333');
    const meta = updated.metadata as Record<string, unknown>;
    expect(meta.optaMatchId).toBe('g333');
  });

  // ── non-unique invariant ─────────────────────────────────────────────────

  test('non-unique index: aynı optaMatchId iki ayrı schedule (farklı kanal) kabul', async () => {
    const user = makeUser({ username: 'tester', groups: ['Booking'] });
    const req = makeRequest(user);

    const a = await svc.create(
      {
        channelId: 1,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Channel 1 broadcast',
        usageScope: 'broadcast',
        optaMatchId: 'g777',
      },
      req,
    );
    const b = await svc.create(
      {
        channelId: 2,
        startTime: isoStart,
        endTime: isoEnd,
        title: 'Channel 2 broadcast (aynı match)',
        usageScope: 'broadcast',
        optaMatchId: 'g777',
      },
      req,
    );

    expect(a.id).not.toBe(b.id);
    expect(a.optaMatchId).toBe('g777');
    expect(b.optaMatchId).toBe('g777');

    // Raw query ile DB'de iki satır olduğunu doğrula.
    const prisma = getRawPrisma();
    const rows = await prisma.schedule.findMany({
      where: { optaMatchId: 'g777' },
      select: { id: true },
    });
    expect(rows.length).toBe(2);
  });
});
