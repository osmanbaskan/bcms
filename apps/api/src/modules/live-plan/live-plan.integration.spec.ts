import { beforeEach, describe, expect, test } from 'vitest';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * Madde 5 M5-B1 spec — live_plan_entries foundation (schema only).
 *
 * Tasarım: ops/DECISION-LIVE-PLAN-DATA-MODEL-V1.md §3.2 (M5-B1 Scope Lock)
 * Migration: 20260506000002_live_plan_entries_foundation
 *
 * Sadece schema/CRUD/enum/FK/index mekanik doğrulamaları (PR-A outbox spec
 * pattern'iyle aynı). Service/route/UI/audit/outbox davranışları M5-B2+'da.
 */

describe('LivePlanEntry — schema foundation (DB integration)', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  test('create with required fields → defaults (status=PLANNED, version=1, nullable defaults null)', async () => {
    const prisma = getRawPrisma();
    const start = new Date('2026-06-01T19:00:00Z');
    const end   = new Date('2026-06-01T21:00:00Z');

    const created = await prisma.livePlanEntry.create({
      data: {
        title:          'Galatasaray vs Fenerbahçe',
        eventStartTime: start,
        eventEndTime:   end,
      },
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.title).toBe('Galatasaray vs Fenerbahçe');
    expect(created.status).toBe('PLANNED');           // K2 default
    expect(created.version).toBe(1);                   // K3 default
    expect(created.matchId).toBeNull();                // K1 nullable
    expect(created.optaMatchId).toBeNull();            // K1 nullable
    expect(created.createdBy).toBeNull();              // K6 nullable
    expect(created.operationNotes).toBeNull();
    expect(created.deletedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
  });

  test('create with all fields populated', async () => {
    const prisma = getRawPrisma();

    // Match seed (FK target — K1 internal Match relation)
    const match = await prisma.match.create({
      data: {
        leagueId:     1, // seed fixture
        homeTeamName: 'Home',
        awayTeamName: 'Away',
        matchDate:    new Date('2026-06-01T19:00:00Z'),
        season:       '2025-2026',
      },
    });

    const created = await prisma.livePlanEntry.create({
      data: {
        title:          'Derbi Operasyon',
        eventStartTime: new Date('2026-06-01T19:00:00Z'),
        eventEndTime:   new Date('2026-06-01T21:00:00Z'),
        matchId:        match.id,
        optaMatchId:    'opta-event-12345',
        status:         'READY',
        operationNotes: 'Özel prodüksiyon',
        // metadata kolonu M5-B4'te DROP edildi (K15.1).
        createdBy:      'integration-test',
      },
    });

    expect(created.matchId).toBe(match.id);
    expect(created.optaMatchId).toBe('opta-event-12345');
    expect(created.status).toBe('READY');
    expect(created.operationNotes).toBe('Özel prodüksiyon');
    expect(created.createdBy).toBe('integration-test');
  });

  test('LivePlanStatus enum tüm 5 değer yazılabilir (mekanik; transition policy M5-B2+)', async () => {
    const prisma = getRawPrisma();
    const statuses = ['PLANNED', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;

    for (const status of statuses) {
      const row = await prisma.livePlanEntry.create({
        data: {
          title:          `entry-${status}`,
          eventStartTime: new Date(),
          eventEndTime:   new Date(Date.now() + 60_000),
          status,
        },
      });
      expect(row.status).toBe(status);
    }

    const count = await prisma.livePlanEntry.count();
    expect(count).toBe(5);
  });

  test('Match FK ON DELETE SET NULL: match silinince entry.matchId NULL olur (K1)', async () => {
    const prisma = getRawPrisma();
    const match = await prisma.match.create({
      data: {
        leagueId:     1,
        homeTeamName: 'Home',
        awayTeamName: 'Away',
        matchDate:    new Date('2026-07-01T19:00:00Z'),
        season:       '2025-2026',
      },
    });

    const entry = await prisma.livePlanEntry.create({
      data: {
        title:          'Match-bound entry',
        eventStartTime: new Date('2026-07-01T19:00:00Z'),
        eventEndTime:   new Date('2026-07-01T21:00:00Z'),
        matchId:        match.id,
      },
    });
    expect(entry.matchId).toBe(match.id);

    // Match'i sil — diğer ref'siz olduğu için Restrict tetiklenmez.
    await prisma.match.delete({ where: { id: match.id } });

    const refreshed = await prisma.livePlanEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(refreshed.matchId).toBeNull();
    expect(refreshed.id).toBe(entry.id); // entry kendisi silinmedi (SetNull, Cascade değil)
  });

  test('opta_match_id unique DEĞİL — aynı OPTA event için birden fazla entry mümkün (K1)', async () => {
    const prisma = getRawPrisma();
    const optaId = 'opta-shared-67890';
    const baseStart = new Date('2026-08-01T19:00:00Z');

    const a = await prisma.livePlanEntry.create({
      data: {
        title:          'Maç Önü',
        eventStartTime: baseStart,
        eventEndTime:   new Date(baseStart.getTime() + 60 * 60_000),
        optaMatchId:    optaId,
      },
    });
    const b = await prisma.livePlanEntry.create({
      data: {
        title:          'Maç',
        eventStartTime: new Date(baseStart.getTime() + 60 * 60_000),
        eventEndTime:   new Date(baseStart.getTime() + 180 * 60_000),
        optaMatchId:    optaId,
      },
    });

    expect(a.id).not.toBe(b.id);
    expect(a.optaMatchId).toBe(optaId);
    expect(b.optaMatchId).toBe(optaId);

    const all = await prisma.livePlanEntry.findMany({ where: { optaMatchId: optaId } });
    expect(all).toHaveLength(2);
  });

  test('index existence sanity: 4 declared index + PK (deleted_at index DEFERRED)', async () => {
    const prisma = getRawPrisma();
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'live_plan_entries'
      ORDER BY indexname
    `;
    const names = rows.map((r) => r.indexname);

    expect(names).toContain('live_plan_entries_status_event_start_idx');
    expect(names).toContain('live_plan_entries_event_start_idx');
    expect(names).toContain('live_plan_entries_match_idx');
    expect(names).toContain('live_plan_entries_opta_match_idx');

    // PK
    const hasPk = names.some((n) => n.endsWith('_pkey'));
    expect(hasPk).toBe(true);

    // deleted_at index DEFERRED — yok olduğu doğrulanır.
    const hasDeletedAtIdx = names.some((n) => n.toLowerCase().includes('deleted'));
    expect(hasDeletedAtIdx).toBe(false);
  });

  test('mekanik update: version increment + status change (M5-B2 If-Match policy hariç)', async () => {
    // M5-B1 scope sadece DB-level mekanik. Optimistic locking If-Match policy
    // M5-B2 service layer'ında gelir; burada sadece kolonun update'i çalışıyor mu.
    const prisma = getRawPrisma();
    const created = await prisma.livePlanEntry.create({
      data: {
        title:          'Update test',
        eventStartTime: new Date(),
        eventEndTime:   new Date(Date.now() + 60_000),
      },
    });
    expect(created.version).toBe(1);

    const updated = await prisma.livePlanEntry.update({
      where: { id: created.id },
      data: {
        status:  'IN_PROGRESS',
        version: { increment: 1 },
      },
    });
    expect(updated.status).toBe('IN_PROGRESS');
    expect(updated.version).toBe(2);

    // Soft delete (deletedAt set; row silinmez)
    const soft = await prisma.livePlanEntry.update({
      where: { id: created.id },
      data:  { deletedAt: new Date() },
    });
    expect(soft.deletedAt).not.toBeNull();
  });
});
