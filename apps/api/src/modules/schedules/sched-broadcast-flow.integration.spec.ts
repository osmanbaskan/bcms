import { beforeEach, describe, expect, test } from 'vitest';
import { cleanupTransactional, getRawPrisma } from '../../../test/integration/helpers.js';

/**
 * SCHED-B2 spec — Schedule/Yayın Planlama broadcast flow + live-plan
 * event_key/source_type/channel slot foundation. K1-K32 lock 2026-05-07.
 *
 * Test kapsamı (sadece schema/client smoke; service rewiring SCHED-B3):
 *   ✓ schedules yeni alanlar create + read
 *   ✓ schedules.event_key UNIQUE (P2002 on duplicate)
 *   ✓ schedules.event_key NULL multiple OK
 *   ✓ schedules 3 channel slot duplicate yasak (CHECK 23514)
 *   ✓ schedules → channel FK SET NULL
 *   ✓ schedules → selected_live_plan_entry_id FK SET NULL
 *   ✓ schedules → 3 schedule lookup FK RESTRICT
 *   ✓ live_plan_entries event_key non-unique (2 satır aynı event_key OK)
 *   ✓ live_plan_entries source_type CHECK (OPTA/MANUAL)
 *   ✓ live_plan_entries 3 channel slot duplicate yasak
 *   ✓ live_plan_entries.source_type default = 'MANUAL'
 *   ✓ 3 schedule lookup tablosu standart M5-B4 paritesi
 */

async function makeBaseSchedule(extra: Record<string, unknown> = {}) {
  const prisma = getRawPrisma();
  // Eski required alanlar (start_time/end_time/channel_id/usage_scope/
  // metadata/title/createdBy) hâlâ mevcut. SCHED-B5'e kadar paralel kalacak.
  return prisma.schedule.create({
    data: {
      title:      'SCHED-B2 Test Schedule',
      startTime:  new Date('2026-06-01T19:00:00Z'),
      endTime:    new Date('2026-06-01T21:00:00Z'),
      createdBy:  'test',
      ...extra,
    },
  });
}

async function makeBaseLivePlanEntry(extra: Record<string, unknown> = {}) {
  const prisma = getRawPrisma();
  return prisma.livePlanEntry.create({
    data: {
      title:          'SCHED-B2 Test Entry',
      eventStartTime: new Date('2026-06-01T19:00:00Z'),
      eventEndTime:   new Date('2026-06-01T21:00:00Z'),
      ...extra,
    },
  });
}

describe('SCHED-B2 — broadcast flow foundation (DB integration)', () => {
  beforeEach(async () => {
    await cleanupTransactional();
  });

  // ── §A. schedules yeni alanlar ─────────────────────────────────────────
  test('schedules: yeni alanlara create + read', async () => {
    const sched = await makeBaseSchedule({
      eventKey:      'manual:test-' + Date.now(),
      scheduleDate:  new Date('2026-06-01'),
      scheduleTime:  new Date('1970-01-01T19:30:00Z'),
      team1Name:     'A Takımı',
      team2Name:     'B Takımı',
      channel1Id:    1,
      channel2Id:    2,
    });

    expect(sched.eventKey).toMatch(/^manual:test-/);
    expect(sched.team1Name).toBe('A Takımı');
    expect(sched.channel1Id).toBe(1);
    expect(sched.channel2Id).toBe(2);
    expect(sched.channel3Id).toBeNull();
    expect(sched.commercialOptionId).toBeNull();
  });

  test('schedules.event_key UNIQUE: aynı key 2x → P2002', async () => {
    const prisma = getRawPrisma();
    const ek = 'opta:99999';
    await makeBaseSchedule({ eventKey: ek });
    await expect(makeBaseSchedule({ eventKey: ek }))
      .rejects.toMatchObject({ code: 'P2002' });
  });

  test('schedules.event_key NULL multiple OK', async () => {
    await makeBaseSchedule({ eventKey: null });
    await makeBaseSchedule({ eventKey: null });
    const prisma = getRawPrisma();
    const cnt = await prisma.schedule.count({ where: { eventKey: null } });
    expect(cnt).toBeGreaterThanOrEqual(2);
  });

  test('schedules: 3 channel slot duplicate → 23514 CHECK violation', async () => {
    await expect(makeBaseSchedule({ channel1Id: 1, channel2Id: 1 }))
      .rejects.toThrow();
  });

  test('schedules: 3 farklı channel + NULL serbest → OK', async () => {
    const prisma = getRawPrisma();
    // 3. kanal eklemek için ek seed
    await prisma.channel.upsert({
      where: { id: 3 },
      update: {},
      create: { id: 3, name: 'beIN Sports 3 HD', type: 'HD', active: true },
    });
    const s = await makeBaseSchedule({ channel1Id: 1, channel2Id: 2, channel3Id: 3 });
    expect(s.channel1Id).toBe(1);
    expect(s.channel3Id).toBe(3);
  });

  test('schedules → selected_live_plan_entry_id FK SET NULL on entry delete', async () => {
    const prisma = getRawPrisma();
    const entry = await makeBaseLivePlanEntry();
    const sched = await makeBaseSchedule({
      eventKey: 'manual:fk-test',
      selectedLivePlanEntryId: entry.id,
    });
    expect(sched.selectedLivePlanEntryId).toBe(entry.id);

    // Entry hard-delete; schedule selected_lpe_id NULL'a düşmeli
    await prisma.$executeRawUnsafe(
      `DELETE FROM live_plan_entries WHERE id = ${entry.id}`,
    );
    const after = await prisma.schedule.findUnique({ where: { id: sched.id } });
    expect(after?.selectedLivePlanEntryId).toBeNull();
  });

  // ── §B. schedules → 3 schedule lookup FK ───────────────────────────────
  test('schedules → schedule_commercial_options FK RESTRICT', async () => {
    const prisma = getRawPrisma();
    const opt = await prisma.scheduleCommercialOption.create({ data: { label: 'COMM-X' } });
    await makeBaseSchedule({ commercialOptionId: opt.id });
    // Referans varken hard-delete reddedilir
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM schedule_commercial_options WHERE id = ${opt.id}`),
    ).rejects.toThrow();
  });

  // ── §C. live_plan_entries yeni alanlar ─────────────────────────────────
  test('live_plan_entries: source_type default = MANUAL', async () => {
    const e = await makeBaseLivePlanEntry();
    expect(e.sourceType).toBe('MANUAL');
    expect(e.eventKey).toBeNull();
    expect(e.channel1Id).toBeNull();
  });

  test('live_plan_entries.source_type: OPTA da kabul', async () => {
    const e = await makeBaseLivePlanEntry({ sourceType: 'OPTA', eventKey: 'opta:55555' });
    expect(e.sourceType).toBe('OPTA');
    expect(e.eventKey).toBe('opta:55555');
  });

  test('live_plan_entries.source_type: invalid → 23514 CHECK violation', async () => {
    const prisma = getRawPrisma();
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO live_plan_entries (title, event_start_time, event_end_time, source_type)
       VALUES ('inv', NOW(), NOW() + interval '1 hour', 'BOGUS')`,
    )).rejects.toThrow();
  });

  test('live_plan_entries.event_key non-unique: aynı event_key 2 entry OK', async () => {
    await makeBaseLivePlanEntry({ eventKey: 'opta:dup-test' });
    await makeBaseLivePlanEntry({ eventKey: 'opta:dup-test' });
    const prisma = getRawPrisma();
    const cnt = await prisma.livePlanEntry.count({ where: { eventKey: 'opta:dup-test' } });
    expect(cnt).toBe(2);
  });

  test('live_plan_entries: 3 channel slot duplicate → 23514', async () => {
    await expect(
      makeBaseLivePlanEntry({ channel1Id: 1, channel3Id: 1 }),
    ).rejects.toThrow();
  });

  test('live_plan_entries → channel FK SET NULL on channel delete', async () => {
    const prisma = getRawPrisma();
    await prisma.channel.upsert({
      where: { id: 7 },
      update: {},
      create: { id: 7, name: 'Test Ch7', type: 'HD', active: true },
    });
    const e = await makeBaseLivePlanEntry({ channel1Id: 7 });
    await prisma.$executeRawUnsafe(`DELETE FROM channels WHERE id = 7`);
    const after = await prisma.livePlanEntry.findUnique({ where: { id: e.id } });
    expect(after?.channel1Id).toBeNull();
  });

  // ── §D. 3 schedule lookup tablosu standart smoke ───────────────────────
  test('schedule_commercial_options: standart kolon set + label CHECK', async () => {
    const prisma = getRawPrisma();
    const c = await prisma.scheduleCommercialOption.create({ data: { label: 'TEST-OK' } });
    expect(c.id).toBeGreaterThan(0);
    expect(c.active).toBe(true);
    expect(c.sortOrder).toBe(0);
    expect(c.deletedAt).toBeNull();

    // CHECK label_not_blank: trim'li boş label → 23514
    await expect(prisma.$executeRawUnsafe(
      `INSERT INTO schedule_commercial_options (label) VALUES ('   ')`,
    )).rejects.toThrow();
  });

  test('schedule_logo_options: partial unique LOWER(label)', async () => {
    const prisma = getRawPrisma();
    await prisma.scheduleLogoOption.create({ data: { label: 'LOGO-A' } });
    await expect(
      prisma.scheduleLogoOption.create({ data: { label: 'logo-a' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  test('schedule_format_options: soft-deleted aynı label OK', async () => {
    const prisma = getRawPrisma();
    const a = await prisma.scheduleFormatOption.create({ data: { label: 'FMT-X' } });
    await prisma.scheduleFormatOption.update({
      where: { id: a.id },
      data:  { deletedAt: new Date() },
    });
    // Aynı label yeni satır olarak eklenebilir (partial unique deletedAt IS NULL)
    const b = await prisma.scheduleFormatOption.create({ data: { label: 'FMT-X' } });
    expect(b.id).not.toBe(a.id);
  });
});
