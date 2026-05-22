import { describe, it, expect } from 'vitest';
import { extractFileCode, resolveChannel, resolveChannelFromPath } from './provys.channel-mapping.js';

describe('provys.channel-mapping › extractFileCode', () => {
  it('returns lowercase code from <code>-<rest>.bxf filenames', () => {
    expect(extractFileCode('ltv-2026-05-22.bxf')).toBe('ltv');
    expect(extractFileCode('LT2-feed.BXF')).toBe('lt2');
    expect(extractFileCode('/mnt/provys/xsnw-haber.bxf')).toBe('xsnw');
  });

  it('returns the whole stem when there is no dash', () => {
    expect(extractFileCode('ltv.bxf')).toBe('ltv');
  });

  it('returns null for non-bxf extensions', () => {
    expect(extractFileCode('ltv-2026-05-22.xml')).toBeNull();
    expect(extractFileCode('ltv-2026-05-22.txt')).toBeNull();
    expect(extractFileCode('ltv-2026-05-22')).toBeNull();
  });

  it('returns null for empty / weird inputs', () => {
    expect(extractFileCode('.bxf')).toBeNull();
    expect(extractFileCode('')).toBeNull();
  });

  it('parses the BXF_Playlist_<CODE>_... Provys exporter naming', () => {
    expect(
      extractFileCode('BXF_Playlist_LT2_20260217_20260217_20260216_195715_caf.bxf'),
    ).toBe('lt2');
    expect(
      extractFileCode('BXF_Playlist_LTV_20260217_20260217_20260216_195715_caf.bxf'),
    ).toBe('ltv');
    expect(
      extractFileCode('BXF_Playlist_LT3_20260301_x.bxf'),
    ).toBe('lt3');
    expect(
      extractFileCode('BXF_Playlist_LT4_y.bxf'),
    ).toBe('lt4');
    expect(
      extractFileCode('BXF_Playlist_LT5_z.bxf'),
    ).toBe('lt5');
    expect(
      extractFileCode('BXF_Playlist_XSNW_20260217_haber.bxf'),
    ).toBe('xsnw');
  });

  it('BXF_Playlist prefix is case-insensitive', () => {
    expect(extractFileCode('bxf_playlist_lt2_20260217_x.bxf')).toBe('lt2');
    expect(extractFileCode('Bxf_Playlist_Xsnw_x.bxf')).toBe('xsnw');
  });

  it('regression: legacy <code>-... and bare <code> forms still work', () => {
    expect(extractFileCode('ltv-2026-05-22.bxf')).toBe('ltv');
    expect(extractFileCode('XSNW-feed.bxf')).toBe('xsnw');
    expect(extractFileCode('ltv.bxf')).toBe('ltv');
    expect(extractFileCode('/mnt/provys/lt5-feed.bxf')).toBe('lt5');
  });

  it('BXF_Playlist with unknown code parses code (resolution stops elsewhere)', () => {
    // extractFileCode is a parser; channel validity is resolveChannel's job.
    expect(extractFileCode('BXF_Playlist_ZZZ_x.bxf')).toBe('zzz');
  });
});

describe('provys.channel-mapping › resolveChannel', () => {
  it('maps every documented fileCode to the right slug', () => {
    expect(resolveChannel('ltv')?.slug).toBe('beinsports1');
    expect(resolveChannel('lt2')?.slug).toBe('beinsports2');
    expect(resolveChannel('lt3')?.slug).toBe('beinsports3');
    expect(resolveChannel('lt4')?.slug).toBe('beinsports4');
    expect(resolveChannel('lt5')?.slug).toBe('beinsports5');
    expect(resolveChannel('xsnw')?.slug).toBe('beinhaber');
  });

  it('returns null for unknown codes', () => {
    expect(resolveChannel('ltz')).toBeNull();
    expect(resolveChannel('unknown')).toBeNull();
    expect(resolveChannel(null)).toBeNull();
    expect(resolveChannel(undefined)).toBeNull();
    expect(resolveChannel('')).toBeNull();
  });

  it('is case-insensitive and trims', () => {
    expect(resolveChannel(' LTV ')?.slug).toBe('beinsports1');
    expect(resolveChannel('Xsnw')?.slug).toBe('beinhaber');
  });
});

describe('provys.channel-mapping › resolveChannelFromPath', () => {
  it('combines extractFileCode + resolveChannel', () => {
    expect(resolveChannelFromPath('/mnt/provys/lt3-2026-05-22.bxf')).toBe('beinsports3');
    expect(resolveChannelFromPath('XSNW-feed.bxf')).toBe('beinhaber');
  });

  it('resolves Provys exporter naming (BXF_Playlist_<CODE>_...) end-to-end', () => {
    expect(
      resolveChannelFromPath('/mnt/provys/BXF_Playlist_LT2_20260217_20260217_20260216_195715_caf.bxf'),
    ).toBe('beinsports2');
    expect(
      resolveChannelFromPath('/mnt/provys/BXF_Playlist_LTV_20260217_x.bxf'),
    ).toBe('beinsports1');
    expect(
      resolveChannelFromPath('/mnt/provys/BXF_Playlist_XSNW_haber.bxf'),
    ).toBe('beinhaber');
  });

  it('returns null when channel cannot be resolved', () => {
    expect(resolveChannelFromPath('zzz-feed.bxf')).toBeNull();
    expect(resolveChannelFromPath('ltv-feed.xml')).toBeNull();
    expect(resolveChannelFromPath('BXF_Playlist_ZZZ_x.bxf')).toBeNull();
  });
});
