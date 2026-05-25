import { buildSlotsForRange } from './studio-plan.types';

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
