/**
 * EGS bülten dosyalarını SMB hedefe yazar — `smbclient` CLI (samba-client) ile.
 *
 * Güvenlik: SMB şifresi argv/env'de SIZMAZ — geçici bir auth dosyasına (0600)
 * yazılır, `smbclient -A` ile okunur, finally'de silinir. Şifre asla loglanmaz.
 * smbclient çıktısı (stderr) hata mesajına alınırken host/paylaşım dışında hassas
 * veri içermez; yine de auth-dosyası yolu dışında argüman taşımayız.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 20_000;

export interface SmbCreds {
  user: string;
  password: string;
  domain: string;
}

export interface SmbParsed {
  host: string;
  share: string;
  dir: string; // paylaşım köküne göre alt dizin ('' olabilir)
}

/** `smb://host/share/alt/dizin/` → { host, share, dir }. */
export function parseSmbUrl(url: string): SmbParsed {
  const m = /^smb:\/\/([^/]+)\/([^/]+)(\/.*)?$/i.exec(url.trim());
  if (!m) throw new Error(`Geçersiz SMB yolu (smb://host/share/... bekleniyor): ${url}`);
  const dir = (m[3] ?? '').replace(/^\/+|\/+$/g, '');
  return { host: m[1], share: m[2], dir };
}

/** Auth dosyası içeriği (smbclient -A formatı). Boş kullanıcı → guest (-N). */
function authFileBody(creds: SmbCreds): string {
  return [
    `username = ${creds.user}`,
    `password = ${creds.password}`,
    `domain = ${creds.domain}`,
    '',
  ].join('\n');
}

export interface SmbPutInput {
  url: string;       // hedef dizin smb URL'i (dosya adı hariç)
  filename: string;  // ör. SPGENE2100_out.WIN
  data: Buffer;
  creds: SmbCreds;
  timeoutMs?: number;
}

/**
 * Tek dosyayı SMB paylaşımındaki dizine yazar. Başarı → { remotePath, bytes }.
 * Hata → smbclient stderr ile Error fırlatır (şifre içermez).
 */
export async function smbPutFile(input: SmbPutInput): Promise<{ remotePath: string; bytes: number }> {
  const { host, share, dir } = parseSmbUrl(input.url);
  const hasAuth = input.creds.user.trim() !== '';
  const work = await mkdtemp(path.join(tmpdir(), 'egs-smb-'));
  const localFile = path.join(work, input.filename);
  const authFile = path.join(work, 'auth');
  try {
    await writeFile(localFile, input.data);
    const args = [`//${host}/${share}`];
    if (hasAuth) {
      await writeFile(authFile, authFileBody(input.creds), { mode: 0o600 });
      args.push('-A', authFile);
    } else {
      args.push('-N');
    }
    // Uzak yol ayracı backslash; alt dizine cd, sonra put.
    const remoteName = input.filename;
    const script = dir
      ? `cd "${dir.replace(/\//g, '\\')}"; put "${localFile}" "${remoteName}"`
      : `put "${localFile}" "${remoteName}"`;
    args.push('-c', script);

    await execFileAsync('smbclient', args, { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    const remotePath = dir ? `${dir}/${remoteName}` : remoteName;
    return { remotePath, bytes: input.data.length };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const msg = (err as Error).message ?? String(err);
    throw new Error(`SMB yazım hatası (${host}/${share}): ${stderr.trim() || msg}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
