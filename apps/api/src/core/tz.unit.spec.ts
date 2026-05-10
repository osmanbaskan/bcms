import { describe, expect, it } from 'vitest';

import {
  ISTANBUL_OFFSET,
  ISTANBUL_TZ,
  composeIstanbulInstant,
  formatIstanbulDate,
  formatIstanbulDateTime,
  formatIstanbulTime,
  istanbulDayRangeUtc,
  istanbulTodayDate,
  normalizeTime,
} from './tz.js';

describe('tz constants', () => {
  it('ISTANBUL_TZ + offset', () => {
    expect(ISTANBUL_TZ).toBe('Europe/Istanbul');
    expect(ISTANBUL_OFFSET).toBe('+03:00');
  });
});

describe('normalizeTime', () => {
  it('HH:mm → HH:mm:00', () => {
    expect(normalizeTime('19:00')).toBe('19:00:00');
  });
  it('HH:mm:ss değişmez', () => {
    expect(normalizeTime('19:00:45')).toBe('19:00:45');
  });
  it('invalid format reject', () => {
    expect(() => normalizeTime('19')).toThrow(/Geçersiz saat/);
    expect(() => normalizeTime('hello')).toThrow(/Geçersiz saat/);
  });
});

describe('composeIstanbulInstant', () => {
  it('Türkiye 19:00 → UTC 16:00 (yaz veya kış fark etmez; Türkiye sabit +03)', () => {
    expect(composeIstanbulInstant('2026-06-01', '19:00').toISOString()).toBe('2026-06-01T16:00:00.000Z');
  });
  it('Gece yarısından önce (00:30) → önceki gün UTC 21:30', () => {
    expect(composeIstanbulInstant('2026-01-01', '00:30').toISOString()).toBe('2025-12-31T21:30:00.000Z');
  });
  it('Saniye dahil', () => {
    expect(composeIstanbulInstant('2026-06-01', '19:00:45').toISOString()).toBe('2026-06-01T16:00:45.000Z');
  });
  it('invalid date reject', () => {
    expect(() => composeIstanbulInstant('06/01/2026', '19:00')).toThrow(/Geçersiz tarih/);
    expect(() => composeIstanbulInstant('2026-6-1', '19:00')).toThrow(/Geçersiz tarih/);
  });
  it('invalid time reject', () => {
    expect(() => composeIstanbulInstant('2026-06-01', '7pm')).toThrow(/Geçersiz saat/);
  });
});

describe('formatIstanbulDate / formatIstanbulTime', () => {
  it('UTC instant → Türkiye saati', () => {
    expect(formatIstanbulDate('2026-06-01T16:00:00.000Z')).toBe('2026-06-01');
    expect(formatIstanbulTime('2026-06-01T16:00:00.000Z')).toBe('19:00');
  });
  it('UTC günü aşan instant → Türkiye ertesi gün', () => {
    // UTC 2026-01-01 00:00 → Türkiye 2026-01-01 03:00
    expect(formatIstanbulDate('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    expect(formatIstanbulTime('2026-01-01T00:00:00.000Z')).toBe('03:00');
    // UTC 2025-12-31 22:00 → Türkiye 2026-01-01 01:00
    expect(formatIstanbulDate('2025-12-31T22:00:00.000Z')).toBe('2026-01-01');
    expect(formatIstanbulTime('2025-12-31T22:00:00.000Z')).toBe('01:00');
  });
  it('withSeconds true', () => {
    expect(formatIstanbulTime('2026-06-01T16:00:45.000Z', true)).toBe('19:00:45');
  });
});

describe('formatIstanbulDateTime', () => {
  it('YYYY-MM-DD HH:mm Türkiye', () => {
    expect(formatIstanbulDateTime('2026-06-01T16:00:00.000Z')).toBe('2026-06-01 19:00');
  });
});

describe('istanbulDayRangeUtc', () => {
  it('Türkiye günü için UTC [gte, lte] inclusive range', () => {
    const r = istanbulDayRangeUtc('2026-06-01');
    expect(r.gte.toISOString()).toBe('2026-05-31T21:00:00.000Z');
    expect(r.lte.toISOString()).toBe('2026-06-01T20:59:59.999Z');
  });
  it('Ay sonu geçişi', () => {
    const r = istanbulDayRangeUtc('2026-01-31');
    expect(r.gte.toISOString()).toBe('2026-01-30T21:00:00.000Z');
    expect(r.lte.toISOString()).toBe('2026-01-31T20:59:59.999Z');
  });
  it('Ertesi gün 00:00 dahil edilmez (lte sınır kontrolü)', () => {
    // Türkiye 2026-06-02 00:00:00 = UTC 2026-06-01T21:00:00 — range.lte'den 1ms sonra.
    const r = istanbulDayRangeUtc('2026-06-01');
    const nextDayStart = new Date('2026-06-01T21:00:00.000Z');
    expect(nextDayStart.getTime() - r.lte.getTime()).toBe(1);
  });
  it('invalid date reject', () => {
    expect(() => istanbulDayRangeUtc('2026/06/01')).toThrow(/Geçersiz tarih/);
  });
});

describe('istanbulTodayDate', () => {
  it('YYYY-MM-DD formatında bir Türkiye tarihi döner', () => {
    const today = istanbulTodayDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Round-trip: bugünün range'i `today`'i inclusive kapsamalı.
    const r = istanbulDayRangeUtc(today);
    const now = Date.now();
    expect(now).toBeGreaterThanOrEqual(r.gte.getTime());
    expect(now).toBeLessThanOrEqual(r.lte.getTime());
  });
});
