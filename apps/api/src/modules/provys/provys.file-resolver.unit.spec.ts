import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listBxfFiles, pickLatestForFileCode, type BxfFileInfo } from './provys.file-resolver.js';

function f(p: string, fileCode: string, mtime: number): BxfFileInfo {
  return { path: p, fileCode, mtime: new Date(mtime) };
}

describe('provys.file-resolver › pickLatestForFileCode (pure)', () => {
  it('returns the file with the newest mtime for the given fileCode', () => {
    const files = [
      f('/dir/ltv-old.bxf', 'ltv', 1000),
      f('/dir/ltv-mid.bxf', 'ltv', 2000),
      f('/dir/ltv-new.bxf', 'ltv', 3000),
    ];
    expect(pickLatestForFileCode(files, 'ltv')?.path).toBe('/dir/ltv-new.bxf');
  });

  it('ignores files belonging to other channels', () => {
    const files = [
      f('/dir/lt2-2026.bxf', 'lt2', 9_999_999),    // newer but wrong code
      f('/dir/ltv-001.bxf', 'ltv', 100),
      f('/dir/ltv-002.bxf', 'ltv', 500),
    ];
    expect(pickLatestForFileCode(files, 'ltv')?.path).toBe('/dir/ltv-002.bxf');
  });

  it('does not regress when an OLDER file fires the event but newer exists', () => {
    // Watcher event eski dosya için tetiklenmiş olsa bile resolver
    // dizindeki en güncel mtime'a göre seçer; eski snapshot ezilmez.
    const files = [
      f('/dir/ltv-old.bxf', 'ltv', 1000),
      f('/dir/ltv-new.bxf', 'ltv', 5000),
    ];
    const pickedAfterOldEvent = pickLatestForFileCode(files, 'ltv');
    expect(pickedAfterOldEvent?.path).toBe('/dir/ltv-new.bxf');
    expect(pickedAfterOldEvent?.mtime.getTime()).toBe(5000);
  });

  it('falls back to the next newest when the latest is removed', () => {
    // Önce 3 dosya; ardından en güncel "silinmiş" gibi listeden çıkarılıyor.
    const before = [
      f('/dir/ltv-a.bxf', 'ltv', 1000),
      f('/dir/ltv-b.bxf', 'ltv', 2000),
      f('/dir/ltv-c.bxf', 'ltv', 3000),
    ];
    expect(pickLatestForFileCode(before, 'ltv')?.path).toBe('/dir/ltv-c.bxf');

    const afterRemoval = before.filter((x) => x.path !== '/dir/ltv-c.bxf');
    expect(pickLatestForFileCode(afterRemoval, 'ltv')?.path).toBe('/dir/ltv-b.bxf');
  });

  it('returns null when no files match the fileCode (channel should be cleared)', () => {
    expect(pickLatestForFileCode([], 'ltv')).toBeNull();
    expect(
      pickLatestForFileCode([f('/dir/xsnw-x.bxf', 'xsnw', 1)], 'ltv'),
    ).toBeNull();
  });

  it('uses deterministic tie-break on equal mtime (lexicographic path)', () => {
    const files = [
      f('/dir/ltv-a.bxf', 'ltv', 5000),
      f('/dir/ltv-z.bxf', 'ltv', 5000),
    ];
    expect(pickLatestForFileCode(files, 'ltv')?.path).toBe('/dir/ltv-z.bxf');
  });

  it('matches case-insensitively and trims the requested fileCode', () => {
    const files = [f('/dir/ltv-1.bxf', 'ltv', 100)];
    expect(pickLatestForFileCode(files, ' LTV ')?.path).toBe('/dir/ltv-1.bxf');
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

  it('enumerates .bxf files with fileCode + mtime, skips non-bxf and unknown codes', async () => {
    await writeWithMtime('ltv-2026-01.bxf', 1_000_000);
    await writeWithMtime('ltv-2026-02.bxf', 2_000_000);
    await writeWithMtime('lt2-feed.bxf',   1_500_000);
    await writeWithMtime('readme.txt',     9_999_999);  // wrong extension
    await writeWithMtime('.bxf',           9_999_999);  // no stem → no fileCode

    const files = await listBxfFiles(dir);
    const byCode = files.map((f) => f.fileCode).sort();
    expect(byCode).toEqual(['lt2', 'ltv', 'ltv']);

    const ltvLatest = pickLatestForFileCode(files, 'ltv');
    expect(path.basename(ltvLatest!.path)).toBe('ltv-2026-02.bxf');
  });

  it('returns [] when the directory does not exist (does not throw)', async () => {
    const out = await listBxfFiles(path.join(dir, 'missing'));
    expect(out).toEqual([]);
  });

  it('after the latest file is removed, resolver picks the next newest', async () => {
    const latest = await writeWithMtime('ltv-new.bxf', 3_000_000);
    await writeWithMtime('ltv-old.bxf', 1_000_000);
    await writeWithMtime('ltv-mid.bxf', 2_000_000);

    let files = await listBxfFiles(dir);
    expect(pickLatestForFileCode(files, 'ltv')?.path).toBe(latest);

    await fs.unlink(latest);
    files = await listBxfFiles(dir);
    expect(path.basename(pickLatestForFileCode(files, 'ltv')!.path)).toBe('ltv-mid.bxf');

    // Hepsi silindiğinde resolver null → caller snapshot temizler.
    for (const f of files) await fs.unlink(f.path);
    const finalFiles = await listBxfFiles(dir);
    expect(pickLatestForFileCode(finalFiles, 'ltv')).toBeNull();
  });
});
