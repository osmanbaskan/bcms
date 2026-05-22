import { describe, it, expect } from 'vitest';
import { classifyCategory } from './provys.classifier.js';

describe('provys.classifier › classifyCategory', () => {
  it('maps REKLAM raw kinds', () => {
    expect(classifyCategory('COMMERCIAL')).toBe('REKLAM');
    expect(classifyCategory('reklam')).toBe('REKLAM');
    expect(classifyCategory('Advertisement')).toBe('REKLAM');
  });

  it('maps KAMU_SPOTU raw kinds (and prefers it over PROMO)', () => {
    expect(classifyCategory('PSA')).toBe('KAMU_SPOTU');
    expect(classifyCategory('Kamu Spotu')).toBe('KAMU_SPOTU');
    expect(classifyCategory('Public Service Announcement')).toBe('KAMU_SPOTU');
  });

  it('maps CANLI raw kinds', () => {
    expect(classifyCategory('LIVE')).toBe('CANLI');
    expect(classifyCategory('canlı')).toBe('CANLI');
    expect(classifyCategory('Naklen Yayın')).toBe('CANLI');
  });

  it('maps TANITIM raw kinds', () => {
    expect(classifyCategory('PROMO')).toBe('TANITIM');
    expect(classifyCategory('Trailer')).toBe('TANITIM');
    expect(classifyCategory('Bumper')).toBe('TANITIM');
    expect(classifyCategory('Tanıtım')).toBe('TANITIM');
  });

  it('maps PROGRAM raw kinds', () => {
    expect(classifyCategory('PROGRAM')).toBe('PROGRAM');
    expect(classifyCategory('Episode')).toBe('PROGRAM');
    expect(classifyCategory('Film')).toBe('PROGRAM');
    expect(classifyCategory('Maç')).toBe('PROGRAM');
  });

  it('passes through already-normalized category names', () => {
    expect(classifyCategory('DIGER')).toBe('DIGER');
    expect(classifyCategory('kamu_spotu')).toBe('KAMU_SPOTU');
    expect(classifyCategory('KAMU SPOTU')).toBe('KAMU_SPOTU');
  });

  it('falls back to DIGER for null, empty and unknown', () => {
    expect(classifyCategory(null)).toBe('DIGER');
    expect(classifyCategory(undefined)).toBe('DIGER');
    expect(classifyCategory('')).toBe('DIGER');
    expect(classifyCategory('   ')).toBe('DIGER');
    expect(classifyCategory('SOMETHING_ELSE')).toBe('DIGER');
    expect(classifyCategory('XYZ')).toBe('DIGER');
  });
});
