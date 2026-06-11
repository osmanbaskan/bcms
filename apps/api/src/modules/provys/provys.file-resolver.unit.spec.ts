import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  extractScheduleRange,
  MAX_RANGE_DAYS,
  extractScheduleDate,
  listBxfFiles,
  listScheduleDatesForFileCode,
  pickLatestForFileCodeAndDate,
  type BxfFileInfo,
} from './provys.file-resolver.js';

function f(p: string, fileCode: string, scheduleDate: string, mtime: number): BxfFileInfo {
  // Tek-gün fixture: dateFrom = dateTo (eski sözleşmenin aralık karşılığı).
  return { path: p, fileCode, dateFrom: scheduleDate, dateTo: scheduleDate, mtime: new Date(mtime) };
}

describe('provys.file-resolver › extractScheduleDate', () => {
  it('parses YYYYMMDD from BXF_Playlist_<CODE>_<YYYYMMDD>_... filenames', () => {
    expect(extractScheduleDate('BXF_Playlist_LT2_20260217_20260217_20260216_195715_caf.bxf')).toBe('2026-02-17');
    expect(extractScheduleDate('BXF_Playlist_LTV_20260518_x.bxf')).toBe('2026-05-18');
    expect(extractScheduleDate('BXF_Playlist_xSNW_20260101_a.bxf')).toBe('2026-01-01');
  });

  it('supports legacy short form <code>-YYYY-MM-DD.bxf', () => {
    expect(extractScheduleDate('ltv-2026-05-22.bxf')).toBe('2026-05-22');
  });

  it('returns null when no date can be extracted', () => {
    expect(extractScheduleDate('random.bxf')).toBeNull();
    expect(extractScheduleDate('BXF_Playlist_LT2_invalid.bxf')).toBeNull();
    expect(extractScheduleDate('')).toBeNull();
  });
});

describe('provys.file-resolver › pickLatestForFileCodeAndDate (pure)', () => {
  it('picks the newest mtime for the SAME (fileCode, scheduleDate) group', () => {
    const files = [
      f('/dir/A_caf.bxf', 'lt2', '2026-02-17', 1000),
      f('/dir/A_zec.bxf', 'lt2', '2026-02-17', 2000),
      f('/dir/A_new.bxf', 'lt2', '2026-02-17', 3000),
    ];
    expect(pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-17')?.path).toBe('/dir/A_new.bxf');
  });

  it('does NOT mix days — different scheduleDate is a separate group', () => {
    const files = [
      f('/dir/2026-02-17.bxf', 'lt2', '2026-02-17', 1000),
      f('/dir/2026-02-18.bxf', 'lt2', '2026-02-18', 9_999_999),  // newer but different day
    ];
    expect(pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-17')?.path).toBe('/dir/2026-02-17.bxf');
    expect(pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-18')?.path).toBe('/dir/2026-02-18.bxf');
  });

  it('older revision event does not regress same-day snapshot', () => {
    const files = [
      f('/dir/old.bxf', 'lt2', '2026-02-17', 1000),
      f('/dir/new.bxf', 'lt2', '2026-02-17', 5000),
    ];
    // Caller eski dosya path'iyle event tetiklemiş olsa bile resolver günün
    // en güncel revision'ını döner — eski snapshot ezilmez.
    const picked = pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-17');
    expect(picked?.path).toBe('/dir/new.bxf');
    expect(picked?.mtime.getTime()).toBe(5000);
  });

  it('latest removed → falls back to next newest in the SAME day', () => {
    const before = [
      f('/dir/a.bxf', 'lt2', '2026-02-17', 1000),
      f('/dir/b.bxf', 'lt2', '2026-02-17', 2000),
      f('/dir/c.bxf', 'lt2', '2026-02-17', 3000),
    ];
    expect(pickLatestForFileCodeAndDate(before, 'lt2', '2026-02-17')?.path).toBe('/dir/c.bxf');
    const afterRemoval = before.filter((x) => x.path !== '/dir/c.bxf');
    expect(pickLatestForFileCodeAndDate(afterRemoval, 'lt2', '2026-02-17')?.path).toBe('/dir/b.bxf');
  });

  it('removing all files of one day does NOT affect other days', () => {
    const files = [
      f('/dir/D1_a.bxf', 'lt2', '2026-02-17', 100),
      f('/dir/D1_b.bxf', 'lt2', '2026-02-17', 200),
      f('/dir/D2_a.bxf', 'lt2', '2026-02-18', 300),
    ];
    // 17 Şubat dosyaları temizlendiyse 18 Şubat group'u dokunulmamalı.
    const onlyOtherDay = files.filter((x) => x.dateFrom !== '2026-02-17');
    expect(pickLatestForFileCodeAndDate(onlyOtherDay, 'lt2', '2026-02-17')).toBeNull();
    expect(pickLatestForFileCodeAndDate(onlyOtherDay, 'lt2', '2026-02-18')?.path).toBe('/dir/D2_a.bxf');
  });

  it('returns null for unknown fileCode or unknown date', () => {
    const files = [f('/dir/x.bxf', 'lt2', '2026-02-17', 1)];
    expect(pickLatestForFileCodeAndDate(files, 'ltv', '2026-02-17')).toBeNull();
    expect(pickLatestForFileCodeAndDate(files, 'lt2', '2099-12-31')).toBeNull();
  });

  it('deterministic tie-break on equal mtime (lex max path)', () => {
    const files = [
      f('/dir/a.bxf', 'lt2', '2026-02-17', 5000),
      f('/dir/z.bxf', 'lt2', '2026-02-17', 5000),
    ];
    expect(pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-17')?.path).toBe('/dir/z.bxf');
  });
});

describe('provys.file-resolver › listScheduleDatesForFileCode', () => {
  it('returns sorted distinct dates for a fileCode', () => {
    const files = [
      f('/dir/a.bxf', 'lt2', '2026-02-18', 1),
      f('/dir/b.bxf', 'lt2', '2026-02-17', 2),
      f('/dir/c.bxf', 'lt2', '2026-02-17', 3),  // duplicate day
      f('/dir/d.bxf', 'ltv', '2026-02-19', 4),  // different channel
    ];
    expect(listScheduleDatesForFileCode(files, 'lt2')).toEqual(['2026-02-17', '2026-02-18']);
    expect(listScheduleDatesForFileCode(files, 'ltv')).toEqual(['2026-02-19']);
    expect(listScheduleDatesForFileCode(files, 'lt3')).toEqual([]);
  });
});

describe('provys.file-resolver › listBxfFiles (real fs, tmpdir)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'provys-resolver-'));
  });
  afterEach(async () => {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function writeWithMtime(name: string, mtimeSec: number): Promise<string> {
    const full = path.join(dir, name);
    await fs.writeFile(full, '<bxf/>');
    const ts = new Date(mtimeSec * 1000);
    await fs.utimes(full, ts, ts);
    return full;
  }

  it('enumerates BXF_Playlist files with fileCode + scheduleDate + mtime', async () => {
    await writeWithMtime('BXF_Playlist_LT2_20260217_x.bxf', 1_000);
    await writeWithMtime('BXF_Playlist_LT2_20260217_y.bxf', 2_000);
    await writeWithMtime('BXF_Playlist_LT2_20260218_z.bxf', 3_000);
    await writeWithMtime('BXF_Playlist_LTV_20260601_a.bxf', 4_000);
    await writeWithMtime('readme.txt', 9_999);                  // ignored
    await writeWithMtime('BXF_Playlist_LT2_invalid.bxf', 9_999); // no date → skipped

    const files = await listBxfFiles(dir);
    expect(files.map((f) => `${f.fileCode}@${f.dateFrom}`).sort())
      .toEqual(['lt2@2026-02-17', 'lt2@2026-02-17', 'lt2@2026-02-18', 'ltv@2026-06-01']);

    const lt2_17 = pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-17');
    expect(path.basename(lt2_17!.path)).toBe('BXF_Playlist_LT2_20260217_y.bxf');
  });

  it('returns [] when the directory does not exist (no throw)', async () => {
    const out = await listBxfFiles(path.join(dir, 'missing'));
    expect(out).toEqual([]);
  });

  it('latest revision removed → next newest same day; all removed → null only for that day', async () => {
    const newest = await writeWithMtime('BXF_Playlist_LT2_20260217_new.bxf', 3_000);
    await writeWithMtime('BXF_Playlist_LT2_20260217_mid.bxf', 2_000);
    await writeWithMtime('BXF_Playlist_LT2_20260217_old.bxf', 1_000);
    // Different day, should never be touched by 17 Şubat cleanup.
    const otherDay = await writeWithMtime('BXF_Playlist_LT2_20260218_a.bxf', 500);

    let files = await listBxfFiles(dir);
    expect(pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-17')?.path).toBe(newest);

    await fs.unlink(newest);
    files = await listBxfFiles(dir);
    expect(path.basename(pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-17')!.path))
      .toBe('BXF_Playlist_LT2_20260217_mid.bxf');

    // 17 Şubat tüm dosyalar silindi; 18 Şubat dokunulmamalı.
    for (const f of files) {
      if (f.dateFrom === '2026-02-17') await fs.unlink(f.path);
    }
    files = await listBxfFiles(dir);
    expect(pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-17')).toBeNull();
    expect(pickLatestForFileCodeAndDate(files, 'lt2', '2026-02-18')?.path).toBe(otherDay);
  });
});

describe('provys.file-resolver › extractScheduleRange — ÇOK GÜNLÜK (2026-06-11)', () => {
  it('aralık deseni: _YYYYMMDD0000_YYYYMMDD0000_ → {from, to} (gerçek örnek ad)', () => {
    expect(extractScheduleRange('BXF_Playlist_SNW_202606080000_202606140000_0611165256_haber7gun.bxf'))
      .toEqual({ from: '2026-06-08', to: '2026-06-14' });
  });
  it("kuyruk ≠ 0000 → REDDET (Osman kuralı: yalnız saat-sıfır 8 hane sayılır)", () => {
    expect(extractScheduleRange('BXF_Playlist_SNW_202606081830_202606140000_x.bxf')).toBeNull();
    expect(extractScheduleRange('BXF_Playlist_SNW_202606080000_202606142359_x.bxf')).toBeNull();
  });
  it('eski tek-gün desen DEĞİŞMEDİ → {from: D, to: D}', () => {
    expect(extractScheduleRange('BXF_Playlist_LT2_20260217_20260217_20260216_195715_caf.bxf'))
      .toEqual({ from: '2026-02-17', to: '2026-02-17' });
  });
  it('ters aralık (to < from) → null', () => {
    expect(extractScheduleRange('BXF_Playlist_SNW_202606140000_202606080000_x.bxf')).toBeNull();
  });
  it(`tavan: ${MAX_RANGE_DAYS} günü aşan aralık → null`, () => {
    expect(extractScheduleRange('BXF_Playlist_SNW_202601010000_202603150000_x.bxf')).toBeNull(); // 74 gün
    expect(extractScheduleRange('BXF_Playlist_SNW_202601010000_202601310000_x.bxf'))
      .toEqual({ from: '2026-01-01', to: '2026-01-31' }); // tam 31 gün OK
  });
  it('pickLatest: aralık dosyası kapsadığı günün adayıdır', () => {
    const files = [
      { path: '/d/range.bxf', fileCode: 'snw', dateFrom: '2026-06-08', dateTo: '2026-06-14', mtime: new Date(5000) },
      { path: '/d/daily.bxf', fileCode: 'snw', dateFrom: '2026-06-12', dateTo: '2026-06-12', mtime: new Date(9000) },
    ];
    expect(pickLatestForFileCodeAndDate(files, 'snw', '2026-06-12')?.path).toBe('/d/daily.bxf'); // mtime kazanır
    expect(pickLatestForFileCodeAndDate(files, 'snw', '2026-06-13')?.path).toBe('/d/range.bxf');
    expect(pickLatestForFileCodeAndDate(files, 'snw', '2026-06-07')).toBeNull();
  });
  it('listScheduleDatesForFileCode: aralık her güne açılır', () => {
    const files = [{ path: '/d/r.bxf', fileCode: 'snw', dateFrom: '2026-06-08', dateTo: '2026-06-10', mtime: new Date(1) }];
    expect(listScheduleDatesForFileCode(files, 'snw')).toEqual(['2026-06-08', '2026-06-09', '2026-06-10']);
  });
});
