import {
  ISTANBUL_OFFSET,
  ISTANBUL_TZ,
  composeIstanbulInstant,
  composeIstanbulIso,
  dateOnlyToIstanbul,
  formatIstanbulDate,
  formatIstanbulDateTime,
  formatIstanbulDateTr,
  formatIstanbulTime,
  istanbulDayRangeUtc,
  istanbulTodayDate,
  normalizeTime,
} from './tz.helpers';

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
  it('invalid reject', () => {
    expect(() => normalizeTime('19')).toThrowError(/Geçersiz saat/);
  });
});

describe('composeIstanbulInstant / composeIstanbulIso', () => {
  it('Türkiye 19:00 → UTC 16:00', () => {
    expect(composeIstanbulIso('2026-06-01', '19:00')).toBe('2026-06-01T16:00:00.000Z');
  });
  it('Gece yarısı öncesi 00:30 → önceki UTC günü 21:30', () => {
    expect(composeIstanbulIso('2026-01-01', '00:30')).toBe('2025-12-31T21:30:00.000Z');
  });
  it('Saniye dahil', () => {
    expect(composeIstanbulIso('2026-06-01', '19:00:45')).toBe('2026-06-01T16:00:45.000Z');
  });
  it('Date object da döndürür', () => {
    expect(composeIstanbulInstant('2026-06-01', '19:00') instanceof Date).toBe(true);
  });
  it('invalid date reject', () => {
    expect(() => composeIstanbulIso('06/01/2026', '19:00')).toThrowError(/Geçersiz tarih/);
  });
  it('invalid time reject', () => {
    expect(() => composeIstanbulIso('2026-06-01', '7pm')).toThrowError(/Geçersiz saat/);
  });
});

describe('formatIstanbulDate / formatIstanbulDateTr / formatIstanbulTime', () => {
  it('UTC → Türkiye date ISO', () => {
    expect(formatIstanbulDate('2026-06-01T16:00:00.000Z')).toBe('2026-06-01');
  });
  it('UTC → Türkiye date dd.MM.yyyy', () => {
    expect(formatIstanbulDateTr('2026-06-01T16:00:00.000Z')).toBe('01.06.2026');
  });
  it('UTC → Türkiye saati HH:mm', () => {
    expect(formatIstanbulTime('2026-06-01T16:00:00.000Z')).toBe('19:00');
  });
  it('UTC gün geçişi → Türkiye ertesi gün', () => {
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
  it('Türkiye günü için UTC [from, to] inclusive ISO', () => {
    const r = istanbulDayRangeUtc('2026-06-01');
    expect(r.from).toBe('2026-05-31T21:00:00.000Z');
    expect(r.to).toBe('2026-06-01T20:59:59.999Z');
  });
  it('Ay sonu geçişi', () => {
    const r = istanbulDayRangeUtc('2026-01-31');
    expect(r.from).toBe('2026-01-30T21:00:00.000Z');
    expect(r.to).toBe('2026-01-31T20:59:59.999Z');
  });
  it('Ertesi gün 00:00 (Türkiye) range dışında', () => {
    const r = istanbulDayRangeUtc('2026-06-01');
    const nextDayStartMs = new Date('2026-06-01T21:00:00.000Z').getTime();
    const toMs = new Date(r.to).getTime();
    expect(nextDayStartMs - toMs).toBe(1);
  });
});

describe('istanbulTodayDate', () => {
  it('YYYY-MM-DD format', () => {
    expect(istanbulTodayDate()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('dateOnlyToIstanbul', () => {
  it('Local Date componentlerini ISO YYYY-MM-DD olarak alır', () => {
    const d = new Date(2026, 5, 1); // local: 1 Haziran 2026
    expect(dateOnlyToIstanbul(d)).toBe('2026-06-01');
  });
});
