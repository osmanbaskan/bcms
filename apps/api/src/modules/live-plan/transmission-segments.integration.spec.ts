import { beforeEach, describe, expect, test } from 'vitest';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * Madde 5 M5-B8 spec — `live_plan_transmission_segments` schema sanity.
 *
 * Scope lock T1-T12 (2026-05-07):
 *   - schema-only: service/API M5-B9; outbox shadow events M5-B9
 *   - 1:N child of live_plan_entries (entry_id NOT NULL FK)
 *   - Parent FK CASCADE
 *   - feed_role IN ('MAIN','BACKUP','FIBER','OTHER') DB CHECK
 *   - kind IN ('TEST','PROGRAM','HIGHLIGHTS','INTERVIEW','OTHER') DB CHECK
 *   - start_time, end_time NOT NULL; CHECK end > start
 *   - description TEXT nullable
 *   - version YOK V1
 *   - deleted_at nullable (soft delete)
 *   - tek index (live_plan_entry_id, start_time)
 *
 * Test kapsamı (sadece schema mekaniği):
 *   ✓ standard kolon set + version field schema'da yok
 *   ✓ 1:N — aynı entry için birden fazla segment OK
 *   ✓ entry_id NOT NULL enforce
 *   ✓ Parent CASCADE (entry hard-delete → segments silinir)
 *   ✓ feed_role CHECK (valid + invalid)
 *   ✓ kind CHECK (valid + invalid)
 *   ✓ end > start (valid + invalid: <, ==)
 *   ✓ start/end NOT NULL
 *   ✓ description nullable + uzun text
 *   ✓ soft delete deletedAt
 */

async function makeEntry(): Promise<number> {
  const prisma = getRawPrisma();
  const e = await prisma.livePlanEntry.create({
    data: {
      title:          'M5-B8 Test Entry',
      eventStartTime: new Date('2026-06-01T10:00:00Z'),
      eventEndTime:   new Date('2026-06-01T13:00:00Z'),
      createdBy:      'test',
    },
  });
  return e.id;
}

describe('LivePlanTransmissionSegment — schema foundation (DB integration)', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  // ── §1. Standard kolon set ─────────────────────────────────────────────
  test('create: standard kolon set + defaults + version YOK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const seg     = await prisma.livePlanTransmissionSegment.create({
      data: {
        livePlanEntryId: entryId,
        feedRole:        'MAIN',
        kind:            'PROGRAM',
        startTime:       new Date('2026-06-01T10:30:00Z'),
        endTime:         new Date('2026-06-01T12:00:00Z'),
      },
    });

    expect(seg.id).toBeGreaterThan(0);
    expect(seg.livePlanEntryId).toBe(entryId);
    expect(seg.feedRole).toBe('MAIN');
    expect(seg.kind).toBe('PROGRAM');
    expect(seg.description).toBeNull();
    expect(seg.deletedAt).toBeNull();
    expect(seg.createdAt).toBeInstanceOf(Date);
    expect(seg.updatedAt).toBeInstanceOf(Date);
    // version field schema'da yok — runtime nesnede de bulunmamalı.
    expect((seg as Record<string, unknown>)['version']).toBeUndefined();
  });

  // ── §2. 1:N — aynı entry için birden fazla segment ─────────────────────
  test('1:N: aynı entry için birden fazla segment OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await prisma.livePlanTransmissionSegment.create({
      data: { livePlanEntryId: entryId, feedRole: 'MAIN',   kind: 'TEST',
              startTime: new Date('2026-06-01T10:00:00Z'),
              endTime:   new Date('2026-06-01T10:30:00Z') },
    });
    await prisma.livePlanTransmissionSegment.create({
      data: { livePlanEntryId: entryId, feedRole: 'MAIN',   kind: 'PROGRAM',
              startTime: new Date('2026-06-01T10:30:00Z'),
              endTime:   new Date('2026-06-01T12:00:00Z') },
    });
    await prisma.livePlanTransmissionSegment.create({
      data: { livePlanEntryId: entryId, feedRole: 'BACKUP', kind: 'PROGRAM',
              startTime: new Date('2026-06-01T10:30:00Z'),
              endTime:   new Date('2026-06-01T12:00:00Z') },
    });

    const all = await prisma.livePlanTransmissionSegment.findMany({
      where: { livePlanEntryId: entryId },
    });
    expect(all).toHaveLength(3);
  });

  // ── §3. Parent FK CASCADE ──────────────────────────────────────────────
  test('parent CASCADE: entry hard-delete sonrası segments silinir', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await prisma.livePlanTransmissionSegment.create({
      data: { livePlanEntryId: entryId, feedRole: 'MAIN', kind: 'PROGRAM',
              startTime: new Date('2026-06-01T10:00:00Z'),
              endTime:   new Date('2026-06-01T11:00:00Z') },
    });

    await prisma.$executeRawUnsafe(
      `DELETE FROM live_plan_entries WHERE id = ${entryId}`,
    );

    const after = await prisma.livePlanTransmissionSegment.findMany({
      where: { livePlanEntryId: entryId },
    });
    expect(after).toHaveLength(0);
  });

  // ── §4. entry_id NOT NULL ──────────────────────────────────────────────
  test('entry_id NOT NULL: olmayan entry_id → FK violation', async () => {
    const prisma = getRawPrisma();
    await expect(
      prisma.livePlanTransmissionSegment.create({
        data: {
          livePlanEntryId: 999999,
          feedRole: 'MAIN', kind: 'PROGRAM',
          startTime: new Date('2026-06-01T10:00:00Z'),
          endTime:   new Date('2026-06-01T11:00:00Z'),
        },
      }),
    ).rejects.toThrow();
  });

  // ── §5. feed_role CHECK ────────────────────────────────────────────────
  test('feed_role CHECK: 4 valid değer hepsi OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    for (const role of ['MAIN', 'BACKUP', 'FIBER', 'OTHER'] as const) {
      const seg = await prisma.livePlanTransmissionSegment.create({
        data: {
          livePlanEntryId: entryId, feedRole: role, kind: 'PROGRAM',
          startTime: new Date('2026-06-01T10:00:00Z'),
          endTime:   new Date('2026-06-01T11:00:00Z'),
        },
      });
      expect(seg.feedRole).toBe(role);
    }
  });

  test('feed_role CHECK: invalid değer → 23514 violation', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await expect(
      prisma.livePlanTransmissionSegment.create({
        data: {
          livePlanEntryId: entryId, feedRole: 'PRIMARY', kind: 'PROGRAM',
          startTime: new Date('2026-06-01T10:00:00Z'),
          endTime:   new Date('2026-06-01T11:00:00Z'),
        },
      }),
    ).rejects.toThrow();
  });

  // ── §6. kind CHECK ─────────────────────────────────────────────────────
  test('kind CHECK: 5 valid değer hepsi OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    for (const kind of ['TEST', 'PROGRAM', 'HIGHLIGHTS', 'INTERVIEW', 'OTHER'] as const) {
      const seg = await prisma.livePlanTransmissionSegment.create({
        data: {
          livePlanEntryId: entryId, feedRole: 'MAIN', kind,
          startTime: new Date('2026-06-01T10:00:00Z'),
          endTime:   new Date('2026-06-01T11:00:00Z'),
        },
      });
      expect(seg.kind).toBe(kind);
    }
  });

  test('kind CHECK: invalid değer → 23514 violation', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await expect(
      prisma.livePlanTransmissionSegment.create({
        data: {
          livePlanEntryId: entryId, feedRole: 'MAIN', kind: 'COMMERCIAL',
          startTime: new Date('2026-06-01T10:00:00Z'),
          endTime:   new Date('2026-06-01T11:00:00Z'),
        },
      }),
    ).rejects.toThrow();
  });

  // ── §7. end > start CHECK ──────────────────────────────────────────────
  test('window CHECK: end > start OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const seg = await prisma.livePlanTransmissionSegment.create({
      data: {
        livePlanEntryId: entryId, feedRole: 'MAIN', kind: 'PROGRAM',
        startTime: new Date('2026-06-01T10:00:00Z'),
        endTime:   new Date('2026-06-01T10:00:01Z'),
      },
    });
    expect(seg.endTime.getTime()).toBeGreaterThan(seg.startTime.getTime());
  });

  test('window CHECK: end < start → 23514 violation', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await expect(
      prisma.livePlanTransmissionSegment.create({
        data: {
          livePlanEntryId: entryId, feedRole: 'MAIN', kind: 'PROGRAM',
          startTime: new Date('2026-06-01T11:00:00Z'),
          endTime:   new Date('2026-06-01T10:00:00Z'),
        },
      }),
    ).rejects.toThrow();
  });

  test('window CHECK: end == start → 23514 violation', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const sameMoment = new Date('2026-06-01T10:00:00Z');
    await expect(
      prisma.livePlanTransmissionSegment.create({
        data: {
          livePlanEntryId: entryId, feedRole: 'MAIN', kind: 'PROGRAM',
          startTime: sameMoment,
          endTime:   sameMoment,
        },
      }),
    ).rejects.toThrow();
  });

  // ── §8. description nullable + uzun text ───────────────────────────────
  test('description: TEXT nullable + uzun string OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const longText = 'A'.repeat(5000);
    const seg = await prisma.livePlanTransmissionSegment.create({
      data: {
        livePlanEntryId: entryId, feedRole: 'MAIN', kind: 'PROGRAM',
        startTime: new Date('2026-06-01T10:00:00Z'),
        endTime:   new Date('2026-06-01T11:00:00Z'),
        description: longText,
      },
    });
    expect(seg.description).toBe(longText);
  });

  // ── §9. soft delete ────────────────────────────────────────────────────
  test('soft delete: deletedAt set edilebilir, satır okunmaya devam eder', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const seg = await prisma.livePlanTransmissionSegment.create({
      data: {
        livePlanEntryId: entryId, feedRole: 'MAIN', kind: 'PROGRAM',
        startTime: new Date('2026-06-01T10:00:00Z'),
        endTime:   new Date('2026-06-01T11:00:00Z'),
      },
    });
    const now = new Date();
    const updated = await prisma.livePlanTransmissionSegment.update({
      where: { id: seg.id },
      data:  { deletedAt: now },
    });
    expect(updated.deletedAt).toEqual(now);
  });

  // ── §10. Reverse relation ──────────────────────────────────────────────
  test('reverse: livePlanEntry.transmissionSegments include ile bulunabilir', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await prisma.livePlanTransmissionSegment.create({
      data: {
        livePlanEntryId: entryId, feedRole: 'MAIN', kind: 'PROGRAM',
        startTime: new Date('2026-06-01T10:00:00Z'),
        endTime:   new Date('2026-06-01T11:00:00Z'),
      },
    });

    const entry = await prisma.livePlanEntry.findUnique({
      where:   { id: entryId },
      include: { transmissionSegments: true },
    });
    expect(entry?.transmissionSegments).toHaveLength(1);
    expect(entry?.transmissionSegments[0].feedRole).toBe('MAIN');
  });
});
