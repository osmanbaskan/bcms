import { buildSlotsForRange, buildStudioPlanWeekOptions } from './studio-plan.types';

describe('studio-plan.types — buildSlotsForRange', () => {
  it('07:00-03:00 default → 80 slot (20 saat × 4)', () => {
    const slots = buildSlotsForRange('07:00', '03:00', 15);
    expect(slots.length).toBe(80);
    expect(slots[0]).toBe('07:00');
    expect(slots[1]).toBe('07:15');
    expect(slots[79]).toBe('02:45');
  });

  it('00:00-00:00 → 96 slot (24 saat × 4)', () => {
    const slots = buildSlotsForRange('00:00', '00:00', 15);
    expect(slots.length).toBe(96);
    expect(slots[0]).toBe('00:00');
    expect(slots[95]).toBe('23:45');
  });

  it('07:00-07:00 → 96 slot (24 saat sarması)', () => {
    const slots = buildSlotsForRange('07:00', '07:00', 15);
    expect(slots.length).toBe(96);
    expect(slots[0]).toBe('07:00');
    // 79. slot 02:45 → 80. slot 03:00 → 95. slot 06:45
    expect(slots[80]).toBe('03:00');
    expect(slots[95]).toBe('06:45');
  });

  it('06:00-12:00 → 24 slot (6 saat)', () => {
    const slots = buildSlotsForRange('06:00', '12:00', 15);
    expect(slots.length).toBe(24);
    expect(slots[0]).toBe('06:00');
    expect(slots[23]).toBe('11:45');
  });

  it('18:00-06:00 → 48 slot (gece sarması 12 saat)', () => {
    const slots = buildSlotsForRange('18:00', '06:00', 15);
    expect(slots.length).toBe(48);
    expect(slots[0]).toBe('18:00');
    expect(slots[23]).toBe('23:45');
    expect(slots[24]).toBe('00:00');
    expect(slots[47]).toBe('05:45');
  });

  it('invalid format → boş array', () => {
    expect(buildSlotsForRange('abc', '03:00', 15)).toEqual([]);
    expect(buildSlotsForRange('07:00', 'xyz', 15)).toEqual([]);
  });
});

describe('studio-plan.types — buildStudioPlanWeekOptions', () => {
  it('2026-05-25 (Pazartesi) → geçen=2026-05-18, bu=2026-05-25, gelecek=2026-06-01', () => {
    const opts = buildStudioPlanWeekOptions('2026-05-25');
    expect(opts.length).toBe(3);
    expect(opts[0].value).toBe('2026-05-18');
    expect(opts[1].value).toBe('2026-05-25');
    expect(opts[2].value).toBe('2026-06-01');
    expect(opts[0].label).toContain('Geçen hafta');
    expect(opts[0].label).toContain('18.05.2026');
    expect(opts[1].label).toContain('Bu hafta');
    expect(opts[1].label).toContain('25.05.2026');
    expect(opts[2].label).toContain('Gelecek hafta');
    expect(opts[2].label).toContain('01.06.2026');
  });

  it('Ay sınırını aşma (Pazartesi 2026-06-01) → geçen=2026-05-25, gelecek=2026-06-08', () => {
    const opts = buildStudioPlanWeekOptions('2026-06-01');
    expect(opts[0].value).toBe('2026-05-25');
    expect(opts[2].value).toBe('2026-06-08');
  });
});
