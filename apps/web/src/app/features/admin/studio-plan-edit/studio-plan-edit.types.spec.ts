import {
  buildHourlyTimeOptions, parseHHMMFlat, validatePrograms, validateColors,
  validateTimeRange, durationMinutes, HEX_RE, mondayOf,
} from './studio-plan-edit.types';

describe('studio-plan-edit.types', () => {
  describe('buildHourlyTimeOptions', () => {
    it('24 saatlik option üretir (00:00..23:00)', () => {
      const opts = buildHourlyTimeOptions();
      expect(opts.length).toBe(24);
      expect(opts[0].value).toBe('00:00');
      expect(opts[1].value).toBe('01:00');
      expect(opts[6].value).toBe('06:00');
      expect(opts[23].value).toBe('23:00');
    });
    it('15 dk grid seçenekleri yok', () => {
      const opts = buildHourlyTimeOptions();
      expect(opts.find((o) => o.value === '06:15')).toBeUndefined();
      expect(opts.find((o) => o.value === '06:30')).toBeUndefined();
      expect(opts.find((o) => o.value === '06:45')).toBeUndefined();
    });
  });

  describe('parseHHMMFlat', () => {
    it('"00:00" → 0 (domain wrap yok)', () => expect(parseHHMMFlat('00:00')).toBe(0));
    it('"06:00" → 360', () => expect(parseHHMMFlat('06:00')).toBe(360));
    it('"23:00" → 1380', () => expect(parseHHMMFlat('23:00')).toBe(1380));
    it('"abc" → null', () => expect(parseHHMMFlat('abc')).toBeNull());
  });

  describe('validatePrograms', () => {
    it('boş ad → hata', () => {
      const errs = validatePrograms([{ name: '', sortOrder: 10, active: true }]);
      expect(errs.length).toBe(1);
      expect(errs[0].message).toContain('boş olamaz');
    });
    it('mükerrer ad → hata', () => {
      const errs = validatePrograms([
        { name: 'HABER CY', sortOrder: 10, active: true },
        { name: 'HABER CY', sortOrder: 20, active: true },
      ]);
      expect(errs.length).toBe(1);
      expect(errs[0].message).toContain('mükerrer');
    });
    it('200 karakter aşımı → hata', () => {
      const errs = validatePrograms([{ name: 'X'.repeat(201), sortOrder: 10, active: true }]);
      expect(errs.length).toBe(1);
      expect(errs[0].message).toContain('200 karakter');
    });
    it('geçerli liste → 0 hata', () => {
      const errs = validatePrograms([
        { name: 'HABER CY', sortOrder: 10, active: true },
        { name: 'beIN SABAH CY', sortOrder: 20, active: true },
      ]);
      expect(errs.length).toBe(0);
    });
    it('201 üzeri sayım → count hatası', () => {
      const programs = Array.from({ length: 201 }, (_, i) => ({
        name: `P${i}`, sortOrder: i * 10, active: true,
      }));
      const errs = validatePrograms(programs);
      expect(errs.some((e) => e.kind === 'count')).toBeTrue();
    });
  });

  describe('validateColors', () => {
    it('hex regex', () => {
      expect(HEX_RE.test('#abcdef')).toBeTrue();
      expect(HEX_RE.test('#ABCDEF')).toBeTrue();
      expect(HEX_RE.test('#abc')).toBeFalse();
      expect(HEX_RE.test('abcdef')).toBeFalse();
      expect(HEX_RE.test('#gggggg')).toBeFalse();
    });
    it('geçersiz hex → hata', () => {
      const errs = validateColors([{ label: 'Test', value: 'nothex', sortOrder: 10, active: true }]);
      expect(errs.some((e) => e.message.includes('hex'))).toBeTrue();
    });
    it('mükerrer label → hata', () => {
      const errs = validateColors([
        { label: 'Test', value: '#ffffff', sortOrder: 10, active: true },
        { label: 'Test', value: '#000000', sortOrder: 20, active: true },
      ]);
      expect(errs.some((e) => e.message.includes('mükerrer'))).toBeTrue();
    });
    it('geçerli liste → 0 hata', () => {
      const errs = validateColors([
        { label: 'HD NEWS', value: '#ffc400', sortOrder: 10, active: true },
        { label: 'BS 1',    value: '#c6d9f1', sortOrder: 20, active: true },
      ]);
      expect(errs.length).toBe(0);
    });
  });

  describe('validateTimeRange (saatlik)', () => {
    it('boş seçim → 2 required hatası', () => {
      const errs = validateTimeRange('', '');
      expect(errs.length).toBeGreaterThanOrEqual(2);
    });
    it('06:15 (15 dk grid) → "saatlik" hatası', () => {
      const errs = validateTimeRange('06:15', '07:00');
      expect(errs.some((e) => e.message.includes('saatlik'))).toBeTrue();
    });
    it('06:00 → 06:00 valid (24 saat özel kuralı)', () => {
      const errs = validateTimeRange('06:00', '06:00');
      expect(errs.length).toBe(0);
    });
    it('06:00 → 02:00 valid (gece sarması)', () => {
      const errs = validateTimeRange('06:00', '02:00');
      expect(errs.length).toBe(0);
    });
    it('06:00 → 07:00 valid (60 dk)', () => {
      const errs = validateTimeRange('06:00', '07:00');
      expect(errs.length).toBe(0);
    });
    it('00:00 → 23:00 valid', () => {
      const errs = validateTimeRange('00:00', '23:00');
      expect(errs.length).toBe(0);
    });
    it('format geçersiz "abc" → hata', () => {
      const errs = validateTimeRange('abc', '07:00');
      expect(errs.some((e) => e.message.toLowerCase().includes('format'))).toBeTrue();
    });
    it('24:00 saat (out of 0-23) → "00-23 aralığında" hatası', () => {
      const errs = validateTimeRange('24:00', '06:00');
      expect(errs.some((e) => e.message.includes('00-23'))).toBeTrue();
    });
  });

  describe('mondayOf', () => {
    it('Pazartesi → kendisi', () => expect(mondayOf(new Date('2026-05-25T12:00:00Z'))).toBe('2026-05-25'));
    it('Cuma 29 May → geriye 25 May', () => expect(mondayOf(new Date('2026-05-29T12:00:00Z'))).toBe('2026-05-25'));
    it('Pazar 31 May → geriye 25 May', () => expect(mondayOf(new Date('2026-05-31T12:00:00Z'))).toBe('2026-05-25'));
    it('Pazartesi 1 June → kendisi', () => expect(mondayOf(new Date('2026-06-01T12:00:00Z'))).toBe('2026-06-01'));
  });

  describe('durationMinutes (saatlik, 24h özel kuralı)', () => {
    it('06:00 → 06:00 = 1440 (24 saat)', () => expect(durationMinutes('06:00', '06:00')).toBe(1440));
    it('00:00 → 00:00 = 1440', () => expect(durationMinutes('00:00', '00:00')).toBe(1440));
    it('06:00 → 07:00 = 60', () => expect(durationMinutes('06:00', '07:00')).toBe(60));
    it('06:00 → 02:00 = 1200 (gece sarması 20 saat)', () => expect(durationMinutes('06:00', '02:00')).toBe(1200));
    it('18:00 → 06:00 = 720 (12 saat)', () => expect(durationMinutes('18:00', '06:00')).toBe(720));
    it('boş → null', () => expect(durationMinutes('', '14:00')).toBeNull());
    it('format invalid → null', () => expect(durationMinutes('abc', '07:00')).toBeNull());
  });
});
