import { beforeEach, describe, expect, test } from 'vitest';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * Madde 5 M5-B7 spec — `live_plan_technical_details` schema sanity.
 *
 * Scope lock S1-S12 (2026-05-07):
 *   - schema-only: service/API M5-B9; outbox shadow events M5-B9
 *   - 1:1 ile live_plan_entries (live_plan_entry_id UNIQUE NOT NULL)
 *   - Parent FK CASCADE; 25 lookup FK RESTRICT
 *   - CHECK end > start (NULL kombinasyonları geçerli)
 *   - active/deleted lookup validation M5-B9'a bırakıldı (DB enforce yok)
 *
 * Test kapsamı (sadece schema mekaniği):
 *   ✓ Standard kolon set + version default = 1
 *   ✓ live_plan_entry_id UNIQUE (1:1)
 *   ✓ Parent FK CASCADE (entry hard-delete → child silinir)
 *   ✓ Lookup FK RESTRICT (referans verilen lookup hard-delete reddedilir)
 *   ✓ CHECK end > start (4 NULL kombinasyon + valid + invalid)
 *   ✓ Domain alanları nullable V1
 *   ✓ Soft delete (deletedAt) pattern
 */

async function makeEntry(): Promise<number> {
  const prisma = getRawPrisma();
  const e = await prisma.livePlanEntry.create({
    data: {
      title:          'M5-B7 Test Entry',
      eventStartTime: new Date('2026-06-01T10:00:00Z'),
      eventEndTime:   new Date('2026-06-01T12:00:00Z'),
      createdBy:      'test',
    },
  });
  return e.id;
}

describe('LivePlanTechnicalDetail — schema foundation (DB integration)', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  // ── §1. Standard kolon set + defaults ────────────────────────────────────
  test('create: standard kolon set + version default = 1', async () => {
    const prisma   = getRawPrisma();
    const entryId  = await makeEntry();
    const created  = await prisma.livePlanTechnicalDetail.create({
      data: { livePlanEntryId: entryId },
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.livePlanEntryId).toBe(entryId);
    expect(created.version).toBe(1);
    expect(created.deletedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.updatedAt).toBeInstanceOf(Date);
    // Domain alanları nullable V1
    expect(created.broadcastLocationId).toBeNull();
    expect(created.fixedPhone1).toBeNull();
    expect(created.plannedStartTime).toBeNull();
    expect(created.plannedEndTime).toBeNull();
    expect(created.fiberBandwidth).toBeNull();
  });

  // ── §2. live_plan_entry_id UNIQUE (1:1) ─────────────────────────────────
  test('1:1 enforce: aynı entry için ikinci technical_details kaydı → P2002', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await prisma.livePlanTechnicalDetail.create({ data: { livePlanEntryId: entryId } });
    await expect(
      prisma.livePlanTechnicalDetail.create({ data: { livePlanEntryId: entryId } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // ── §3. Parent FK CASCADE (S4) ──────────────────────────────────────────
  test('parent CASCADE: entry hard-delete sonrası technical_details silinir', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const td      = await prisma.livePlanTechnicalDetail.create({
      data: { livePlanEntryId: entryId },
    });

    // Hard delete entry
    await prisma.$executeRawUnsafe(
      `DELETE FROM live_plan_entries WHERE id = ${entryId}`,
    );

    const after = await prisma.livePlanTechnicalDetail.findUnique({ where: { id: td.id } });
    expect(after).toBeNull();
  });

  // ── §4. Lookup FK RESTRICT (S5) ─────────────────────────────────────────
  test('lookup RESTRICT: referans verilen satellite hard-delete reddedilir', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const sat     = await prisma.transmissionSatellite.create({ data: { label: 'TS-RESTRICT' } });

    await prisma.livePlanTechnicalDetail.create({
      data: { livePlanEntryId: entryId, satelliteId: sat.id },
    });

    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM transmission_satellites WHERE id = ${sat.id}`),
    ).rejects.toThrow(); // 23503 FK violation
  });

  test('lookup RESTRICT: bağlantısı olmayan lookup serbestçe silinir', async () => {
    const prisma = getRawPrisma();
    const sat    = await prisma.transmissionSatellite.create({ data: { label: 'TS-FREE' } });
    // Hiçbir technical_details satırı bu sat'a referans vermiyor.
    await prisma.$executeRawUnsafe(
      `DELETE FROM transmission_satellites WHERE id = ${sat.id}`,
    );
    const after = await prisma.transmissionSatellite.findUnique({ where: { id: sat.id } });
    expect(after).toBeNull();
  });

  // ── §5. CHECK planned_end_time > planned_start_time (S9) ────────────────
  test('CHECK: ikisi NULL → OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await expect(
      prisma.livePlanTechnicalDetail.create({
        data: { livePlanEntryId: entryId, plannedStartTime: null, plannedEndTime: null },
      }),
    ).resolves.toBeDefined();
  });

  test('CHECK: start NULL + end NOT NULL → OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await expect(
      prisma.livePlanTechnicalDetail.create({
        data: {
          livePlanEntryId: entryId,
          plannedStartTime: null,
          plannedEndTime:   new Date('2026-06-01T11:00:00Z'),
        },
      }),
    ).resolves.toBeDefined();
  });

  test('CHECK: start NOT NULL + end NULL → OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await expect(
      prisma.livePlanTechnicalDetail.create({
        data: {
          livePlanEntryId: entryId,
          plannedStartTime: new Date('2026-06-01T10:00:00Z'),
          plannedEndTime:   null,
        },
      }),
    ).resolves.toBeDefined();
  });

  test('CHECK: end > start → OK', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const td = await prisma.livePlanTechnicalDetail.create({
      data: {
        livePlanEntryId: entryId,
        plannedStartTime: new Date('2026-06-01T10:00:00Z'),
        plannedEndTime:   new Date('2026-06-01T11:30:00Z'),
      },
    });
    expect(td.plannedStartTime).toBeInstanceOf(Date);
    expect(td.plannedEndTime).toBeInstanceOf(Date);
  });

  test('CHECK: end < start → 23514 violation', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await expect(
      prisma.livePlanTechnicalDetail.create({
        data: {
          livePlanEntryId: entryId,
          plannedStartTime: new Date('2026-06-01T11:00:00Z'),
          plannedEndTime:   new Date('2026-06-01T10:00:00Z'),
        },
      }),
    ).rejects.toThrow();
  });

  test('CHECK: end == start → 23514 violation', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const sameMoment = new Date('2026-06-01T10:00:00Z');
    await expect(
      prisma.livePlanTechnicalDetail.create({
        data: {
          livePlanEntryId: entryId,
          plannedStartTime: sameMoment,
          plannedEndTime:   sameMoment,
        },
      }),
    ).rejects.toThrow();
  });

  // ── §6. FK referans (sample lookup setlerinde) ──────────────────────────
  test('FK doğrulama: var olan lookup id verildi → kayıt başarılı', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const sat     = await prisma.transmissionSatellite.create({ data: { label: 'TS-OK' } });
    const ird     = await prisma.transmissionIrd.create({ data: { label: 'IRD-OK' } });
    const loc     = await prisma.livePlanLocation.create({ data: { label: 'LOC-OK' } });

    const td = await prisma.livePlanTechnicalDetail.create({
      data: {
        livePlanEntryId:    entryId,
        satelliteId:        sat.id,
        ird1Id:             ird.id,
        broadcastLocationId: loc.id,
      },
    });
    expect(td.satelliteId).toBe(sat.id);
    expect(td.ird1Id).toBe(ird.id);
    expect(td.broadcastLocationId).toBe(loc.id);
  });

  test('FK doğrulama: var olmayan lookup id → P2003 / FK violation', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await expect(
      prisma.livePlanTechnicalDetail.create({
        data: { livePlanEntryId: entryId, satelliteId: 999999 },
      }),
    ).rejects.toThrow();
  });

  // ── §6b. secondLanguageId (Yabancı Dil — 2026-05-11 add column) ─────────
  test('secondLanguageId: aynı live_plan_languages lookup ile yazılır', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const lang    = await prisma.livePlanLanguage.create({ data: { label: 'LANG-MAIN' } });
    const second  = await prisma.livePlanLanguage.create({ data: { label: 'LANG-SECOND' } });

    const td = await prisma.livePlanTechnicalDetail.create({
      data: {
        livePlanEntryId:  entryId,
        languageId:       lang.id,
        secondLanguageId: second.id,
      },
    });
    expect(td.languageId).toBe(lang.id);
    expect(td.secondLanguageId).toBe(second.id);
  });

  test('secondLanguageId FK RESTRICT: referanslı language hard-delete reddedilir', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const lang    = await prisma.livePlanLanguage.create({ data: { label: 'LANG-RESTRICT' } });
    await prisma.livePlanTechnicalDetail.create({
      data: { livePlanEntryId: entryId, secondLanguageId: lang.id },
    });
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM live_plan_languages WHERE id = ${lang.id}`),
    ).rejects.toThrow();
  });

  // ── §7. Soft delete pattern ─────────────────────────────────────────────
  test('soft delete: deletedAt set edilebilir, satır okunmaya devam eder', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    const td      = await prisma.livePlanTechnicalDetail.create({
      data: { livePlanEntryId: entryId },
    });
    const now = new Date();
    const updated = await prisma.livePlanTechnicalDetail.update({
      where: { id: td.id },
      data:  { deletedAt: now },
    });
    expect(updated.deletedAt).toEqual(now);
  });

  // ── §8. live_plan_entry tarafında reverse relation görünümü ─────────────
  test('reverse: livePlanEntry.technicalDetails include ile bulunabilir', async () => {
    const prisma  = getRawPrisma();
    const entryId = await makeEntry();
    await prisma.livePlanTechnicalDetail.create({
      data: { livePlanEntryId: entryId, fixedPhone1: '+90 555 1234' },
    });

    const entry = await prisma.livePlanEntry.findUnique({
      where:   { id: entryId },
      include: { technicalDetails: true },
    });
    expect(entry?.technicalDetails?.fixedPhone1).toBe('+90 555 1234');
  });
});
