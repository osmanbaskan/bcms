import { describe, it, expect } from 'vitest';
import { parseAsrunFilename } from './asrun.filename.js';

describe('asrun.filename › parseAsrunFilename', () => {
  it.each([
    ['beIN SPORTS 1 HD_NEXIO33-P1_20260522_000000.bxf',    'beinsports1', '2026-05-22'],
    ['beIN SPORTS 1 HD_MP_NEXIO33-P1_20260522_000000.bxf', 'beinsports1', '2026-05-22'],
    ['beIN SPORTS 2 HD_NEXIO33-P4_20260402_000000.bxf',    'beinsports2', '2026-04-02'],
    ['beIN SPORTS 3 HD_NEXIO36-P4_20260522_000000.bxf',    'beinsports3', '2026-05-22'],
    ['beIN SPORTS 4 HD_NEXIO-PLAYER 45_20260522_000000.bxf', 'beinsports4', '2026-05-22'],
    ['beIN SPORTS 5 HD_Nexio32-P2_20260522_000000.bxf',    'beinsports5', '2026-05-22'],
    ['beIN HABER HD_NEXIO33-P1_20260522_000000.bxf',       'beinhaber',   '2026-05-22'],
    ['beIN NEWS HD_X_20260522_123456.bxf',                 'beinhaber',   '2026-05-22'],
  ])('parses %p → channel=%s, date=%s', (filename, expectedChannel, expectedDate) => {
    const parsed = parseAsrunFilename(filename);
    expect(parsed).not.toBeNull();
    expect(parsed!.channelSlug).toBe(expectedChannel as 'beinsports1');
    expect(parsed!.scheduleDate).toBe(expectedDate);
  });

  it('extracts fileDate + fileTime raw', () => {
    const parsed = parseAsrunFilename('beIN SPORTS 1 HD_NEXIO33-P1_20260522_134501.bxf')!;
    expect(parsed.fileDate).toBe('20260522');
    expect(parsed.fileTime).toBe('134501');
  });

  it('handles Windows " - Copy.bxf" suffix', () => {
    const parsed = parseAsrunFilename('beIN SPORTS 3 HD_NEXIO33-P3_20260504_000000 - Copy.bxf');
    expect(parsed).not.toBeNull();
    expect(parsed!.channelSlug).toBe('beinsports3');
    expect(parsed!.scheduleDate).toBe('2026-05-04');
  });

  it('handles "_ok.bxf" suffix', () => {
    const parsed = parseAsrunFilename('beIN SPORTS 5 HD_Nexio33-P2_20260501_000000_ok.bxf');
    expect(parsed).not.toBeNull();
    expect(parsed!.channelSlug).toBe('beinsports5');
    expect(parsed!.scheduleDate).toBe('2026-05-01');
  });

  it('full path input (basename extraction)', () => {
    const parsed = parseAsrunFilename('/app/tmp/asrun/beIN SPORTS 2 HD_NEXIO33-P4_20260402_000000.bxf');
    expect(parsed?.channelSlug).toBe('beinsports2');
  });

  it.each([
    ['random.bxf'],
    ['something.txt'],
    ['BXF_Playlist_LT2_20260217.bxf'],          // Provys naming → null
    ['beIN SPORTS 6 HD_X_20260522_000000.bxf'], // 6 yok
    ['beIN SPORTS 1 HD_X.bxf'],                 // tarih yok
    ['beIN SPORTS 1 HD_X_20261301_000000.bxf'], // ay 13 → null (sanity)
    [''],
  ])('returns null for invalid %p', (filename) => {
    expect(parseAsrunFilename(filename)).toBeNull();
  });

  it('case-insensitive prefix match', () => {
    expect(parseAsrunFilename('BEIN SPORTS 1 HD_X_20260522_000000.bxf')?.channelSlug).toBe('beinsports1');
    expect(parseAsrunFilename('bein sports 1 HD_X_20260522_000000.BXF')?.channelSlug).toBe('beinsports1');
  });
});
