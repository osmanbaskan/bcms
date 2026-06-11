/**
 * BxfSource unit testleri — ağ/smbclient YOK (fake exec), Local için tmpdir.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseSmbUrl, parseSmbLsLine, isSmbUrl, createBxfSource,
  LocalDirSource, SmbDirSource,
} from './bxf-source.js';

describe('parseSmbUrl', () => {
  it('smb://host/share/alt/dizin/ → parçalar', () => {
    expect(parseSmbUrl('smb://172.26.33.245/mcr/PROVYS/beINPort/'))
      .toEqual({ host: '172.26.33.245', share: 'mcr', dir: 'PROVYS/beINPort' });
  });
  it('paylaşım kökü (dir boş)', () => {
    expect(parseSmbUrl('smb://srv/share')).toEqual({ host: 'srv', share: 'share', dir: '' });
  });
  it('geçersiz → throw', () => {
    expect(() => parseSmbUrl('//srv/share')).toThrow(/Geçersiz SMB/);
  });
});

describe('parseSmbLsLine — smbclient `ls` çıktısı', () => {
  it('dosya satırı çözülür', () => {
    const f = parseSmbLsLine('  BXF_Playlist_SNW_20260611_x.bxf      A  1508668  Thu Jun 11 17:46:18 2026');
    expect(f).toMatchObject({ name: 'BXF_Playlist_SNW_20260611_x.bxf', size: 1508668 });
    expect(f?.mtime.getFullYear()).toBe(2026);
  });
  it('dizinler (D) ve ./.. elenir', () => {
    expect(parseSmbLsLine('  .                                   D        0  Thu Jun 11 17:46:18 2026')).toBeNull();
    expect(parseSmbLsLine('  Klasor                              D        0  Thu Jun 11 17:46:18 2026')).toBeNull();
  });
  it('boşluklu dosya adı desteklenir', () => {
    const f = parseSmbLsLine('  beIN SPORTS 1 HD_file 20260611.bxf      A  123  Thu Jun 11 17:46:18 2026');
    expect(f?.name).toBe('beIN SPORTS 1 HD_file 20260611.bxf');
  });
  it('disk-özeti / boş satır → null', () => {
    expect(parseSmbLsLine('\t\t2550136832 blocks of size 4096.')).toBeNull();
    expect(parseSmbLsLine('')).toBeNull();
  });
});

describe('isSmbUrl + createBxfSource factory', () => {
  it('smb:// → SmbDirSource (kimliksiz → throw); diğer → LocalDirSource', () => {
    expect(isSmbUrl('smb://h/s/d')).toBe(true);
    expect(isSmbUrl('/app/tmp/provys')).toBe(false);
    expect(() => createBxfSource('smb://h/s')).toThrow(/kimlik/);
    expect(createBxfSource('/tmp/x').kind).toBe('local');
    expect(createBxfSource('smb://h/s', { user: 'u', password: 'p', domain: 'd' }).kind).toBe('smb');
  });
});

describe('LocalDirSource (tmpdir)', () => {
  it('list + read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bxfsrc-'));
    try {
      await writeFile(path.join(dir, 'a.bxf'), 'icerik-a');
      const src = new LocalDirSource(dir);
      const files = await src.list();
      expect(files.map((f) => f.name)).toEqual(['a.bxf']);
      expect(await src.read('a.bxf')).toBe('icerik-a');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SmbDirSource — fake exec (smbclient YOK)', () => {
  const LS_OUT = [
    '  .                                   D        0  Thu Jun 11 17:00:00 2026',
    '  ..                                  D        0  Thu Jun 11 17:00:00 2026',
    '  one.bxf      A  10  Thu Jun 11 17:00:00 2026',
    '',
    '\t\t999 blocks of size 4096. 1 blocks available',
  ].join('\n');

  function makeSource(calls: string[][]) {
    const fakeExec = (async (_cmd: string, args: string[]) => {
      calls.push(args);
      const cmd = args[args.indexOf('-c') + 1];
      if (cmd === 'ls') return { stdout: LS_OUT, stderr: '' };
      // get "name" /tmp/xxx → hedefe içerik yaz
      const m = /^get ".*" (.+)$/.exec(cmd);
      if (m) { await writeFile(m[1], 'SMB-ICERIK'); return { stdout: '', stderr: '' }; }
      throw new Error('beklenmeyen komut: ' + cmd);
    }) as unknown as ConstructorParameters<typeof SmbDirSource>[2];
    return new SmbDirSource('smb://h/s/d', { user: 'u', password: 'gizli', domain: 'dm' }, fakeExec);
  }

  it('list: ls çıktısı dosyalara çözülür; auth dosyası argv\'de, şifre DEĞİL', async () => {
    const calls: string[][] = [];
    const src = makeSource(calls);
    const files = await src.list();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'one.bxf', size: 10 });
    const flat = calls.flat().join(' ');
    expect(flat).toContain('//h/s');
    expect(flat).toContain('-A');
    expect(flat).not.toContain('gizli'); // şifre argv'ye sızmaz
  });

  it('read: içerik döner ve (name|mtime|size) LRU ikinci okumayı engeller', async () => {
    const calls: string[][] = [];
    const src = makeSource(calls);
    const mt = new Date('2026-06-11T17:00:00Z');
    const a = await src.read('one.bxf', mt, 10);
    const b = await src.read('one.bxf', mt, 10); // cache hit
    expect(a).toBe('SMB-ICERIK');
    expect(b).toBe('SMB-ICERIK');
    const gets = calls.filter((args) => String(args[args.indexOf('-c') + 1]).startsWith('get'));
    expect(gets).toHaveLength(1); // tek smbclient get
  });

  it('mtime değişirse cache MISS → yeniden okur', async () => {
    const calls: string[][] = [];
    const src = makeSource(calls);
    await src.read('one.bxf', new Date(1000), 10);
    await src.read('one.bxf', new Date(2000), 10);
    const gets = calls.filter((args) => String(args[args.indexOf('-c') + 1]).startsWith('get'));
    expect(gets).toHaveLength(2);
  });
});
