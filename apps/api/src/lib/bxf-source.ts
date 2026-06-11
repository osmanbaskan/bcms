/**
 * BXF dosya kaynağı soyutlaması (2026-06-11) — Provys watcher'ın "mount
 * edilmiş klasör" bağımlılığını kaldırmak için.
 *
 *  - LocalDirSource : bugünkü davranış (fs) — yol `/...` ise.
 *  - SmbDirSource   : `smb://host/share/dir` — `smbclient` CLI (Samba 4.x,
 *    SMB3) ile list/read. Neden CLI? `@marsaud/smb2` NTLM'i DES kullanıyor
 *    ve Node20/OpenSSL3'te ancak süreç-geneli legacy-provider bayrağıyla
 *    çalışıyor (F0 testi, 2026-06-11) — kripto duruşunu zayıflatmamak için
 *    egs-smb.ts'te kanıtlanmış CLI kalıbı seçildi.
 *
 * Güvenlik: SMB şifresi argv/env'e SIZMAZ — 0600 geçici auth dosyası +
 * `smbclient -A`, finally'de silinir (egs-smb paterni). Şifre loglanmaz.
 *
 * İçerik LRU'su: (name|mtime|size) anahtarıyla — çok-günlük bir dosya 8 ayrı
 * gün-senkronunda yalnız BİR kez okunur.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { mkdtemp, writeFile, rm, readFile as readFsFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const SMB_TIMEOUT_MS = 30_000;
const CONTENT_CACHE_MAX = 24;

export interface BxfFileStat {
  /** Dizin içindeki dosya adı (alt dizin yok — düz klasör sözleşmesi). */
  name: string;
  mtime: Date;
  size: number;
}

export interface BxfSource {
  readonly kind: 'local' | 'smb';
  /** Log/teşhis için insan-okur kaynak tanımı (şifre içermez). */
  describe(): string;
  /** Klasördeki dosyaları listeler. HATA → throw (caller diff YAPMAMALI). */
  list(): Promise<BxfFileStat[]>;
  /** Dosya içeriğini okur (utf-8). mtime/size verilirse LRU anahtarı olur. */
  read(name: string, mtime?: Date, size?: number): Promise<string>;
}

export interface SmbCreds {
  user: string;
  password: string;
  domain: string;
}

/** Sabit kimlik ya da her çağrıda taze okuyan sağlayıcı (ayar canlı değişebilir). */
export type SmbCredsInput = SmbCreds | (() => Promise<SmbCreds>);

/** Basit (name|mtime|size) anahtarlı içerik LRU'su. */
class ContentCache {
  private map = new Map<string, string>();
  key(name: string, mtime?: Date, size?: number): string | null {
    if (!mtime || size === undefined) return null;
    return `${name}|${mtime.getTime()}|${size}`;
  }
  get(k: string | null): string | undefined {
    if (!k) return undefined;
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); } // LRU bump
    return v;
  }
  set(k: string | null, v: string): void {
    if (!k) return;
    this.map.set(k, v);
    while (this.map.size > CONTENT_CACHE_MAX) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
}

// ── Local ────────────────────────────────────────────────────────────────────
export class LocalDirSource implements BxfSource {
  readonly kind = 'local' as const;
  constructor(private readonly dir: string) {}
  describe(): string { return this.dir; }

  async list(): Promise<BxfFileStat[]> {
    const entries = await fs.readdir(this.dir);
    const out: BxfFileStat[] = [];
    for (const name of entries) {
      try {
        const st = await fs.stat(path.join(this.dir, name));
        if (st.isFile()) out.push({ name, mtime: st.mtime, size: st.size });
      } catch { /* enumerasyon-sonrası silinme yarışı; atla */ }
    }
    return out;
  }

  async read(name: string): Promise<string> {
    return readFsFile(path.join(this.dir, name), 'utf-8');
  }
}

// ── SMB (smbclient CLI) ──────────────────────────────────────────────────────
export interface SmbParsed { host: string; share: string; dir: string }

/** `smb://host/share/alt/dizin/` → parçalar. Geçersizse throw. */
export function parseSmbUrl(url: string): SmbParsed {
  const m = /^smb:\/\/([^/]+)\/([^/]+)(\/.*)?$/i.exec(url.trim());
  if (!m) throw new Error(`Geçersiz SMB yolu (smb://host/share/... bekleniyor): ${url}`);
  const dir = (m[3] ?? '').replace(/^\/+|\/+$/g, '');
  return { host: m[1], share: m[2], dir };
}

/**
 * `smbclient -c ls` satırını çözer. Örnek:
 *   `  BXF_Playlist_SNW_20260611_x.bxf      A  1508668  Thu Jun 11 17:46:18 2026`
 * Dizinler (attr D içerir) ve ./.. elenir. Çözülemeyen satır → null.
 */
export function parseSmbLsLine(line: string): BxfFileStat | null {
  const m = /^\s{2}(.+?)\s{2,}([A-Za-z]*)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s*$/.exec(line);
  if (!m) return null;
  const [, name, attrs, sizeStr, dateStr] = m;
  if (name === '.' || name === '..') return null;
  if (attrs.includes('D')) return null; // dizin
  const mtime = new Date(dateStr);
  if (Number.isNaN(mtime.getTime())) return null;
  return { name, mtime, size: Number(sizeStr) };
}

export class SmbDirSource implements BxfSource {
  readonly kind = 'smb' as const;
  private readonly parsed: SmbParsed;
  private readonly cache = new ContentCache();

  constructor(
    url: string,
    private readonly creds: SmbCredsInput,
    /** Test seam — gerçek smbclient yerine sahte exec. */
    private readonly exec: typeof execFileAsync = execFileAsync,
  ) {
    this.parsed = parseSmbUrl(url);
  }

  private async resolveCreds(): Promise<SmbCreds> {
    return typeof this.creds === 'function' ? this.creds() : this.creds;
  }

  describe(): string {
    return `smb://${this.parsed.host}/${this.parsed.share}/${this.parsed.dir}`;
  }

  /** 0600 auth dosyasıyla smbclient çalıştırır; dosya finally'de silinir. */
  private async run(commands: string): Promise<string> {
    const creds = await this.resolveCreds();
    if (!creds.user) throw new Error(`SMB kimliği eksik (${this.describe()})`);
    const dir = await mkdtemp(path.join(tmpdir(), 'bxf-smb-'));
    const authFile = path.join(dir, 'auth');
    try {
      await writeFile(
        authFile,
        `username=${creds.user}\npassword=${creds.password}\ndomain=${creds.domain}\n`,
        { mode: 0o600 },
      );
      const args = [
        `//${this.parsed.host}/${this.parsed.share}`,
        '-A', authFile,
        ...(this.parsed.dir ? ['-D', this.parsed.dir] : []),
        '-c', commands,
      ];
      const { stdout } = await this.exec('smbclient', args, {
        timeout: SMB_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // NT_STATUS satırı varsa onu öne çıkar (şifre asla mesajda yer almaz).
      const nt = /NT_STATUS_\w+/.exec(msg)?.[0];
      throw new Error(`smbclient ${nt ?? 'hatası'} (${this.describe()})`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(): Promise<BxfFileStat[]> {
    const out = await this.run('ls');
    const files: BxfFileStat[] = [];
    for (const line of out.split('\n')) {
      const f = parseSmbLsLine(line);
      if (f) files.push(f);
    }
    return files;
  }

  async read(name: string, mtime?: Date, size?: number): Promise<string> {
    const key = this.cache.key(name, mtime, size);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const tmp = path.join(tmpdir(), `bxf-get-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      // get hedefi yerel geçici dosya; ad çift tırnak içinde (boşluklu adlar).
      await this.run(`get "${name.replace(/"/g, '')}" ${tmp}`);
      const content = await readFsFile(tmp, 'utf-8');
      this.cache.set(key, content);
      return content;
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────
export function isSmbUrl(pathOrUrl: string): boolean {
  return /^smb:\/\//i.test(pathOrUrl.trim());
}

export function createBxfSource(pathOrUrl: string, creds?: SmbCredsInput | null): BxfSource {
  if (isSmbUrl(pathOrUrl)) {
    if (!creds) {
      throw new Error('SMB kaynağı için kimlik gerekli (kullanıcı/şifre/domain)');
    }
    return new SmbDirSource(pathOrUrl, creds);
  }
  return new LocalDirSource(pathOrUrl);
}
