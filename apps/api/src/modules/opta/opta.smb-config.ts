import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_PATH = path.join(os.homedir(), '.bcms-opta-config.json');
const CRED_PATH   = path.join(os.homedir(), '.bcms-opta.cred');

export interface SmbConfig {
  share:      string;  // //server/share
  mountPoint: string;  // /mnt/opta-backups
  subdir:     string;  // OPTAfromFTP20511
  username:   string;
  password:   string;
  domain:     string;
}

const DEFAULTS: SmbConfig = {
  share:      process.env.OPTA_SMB_SHARE      ?? '',
  mountPoint: process.env.OPTA_SMB_MOUNT_POINT ?? '/mnt/opta-backups',
  subdir:     process.env.OPTA_SMB_SUBDIR      ?? '',
  username:   process.env.OPTA_SMB_USERNAME    ?? '',
  password:   process.env.OPTA_SMB_PASSWORD    ?? '',
  domain:     process.env.OPTA_SMB_DOMAIN      ?? '',
};

export function readSmbConfig(): SmbConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSmbConfig(cfg: SmbConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  // ORTA-API-1.8.9 fix (2026-05-04): writeFileSync mode option dosya zaten
  // varsa override etmiyor — defansif chmodSync ile eski mode'u sıkıştır.
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* best-effort */ }
  writeCredFile(cfg);
}

function writeCredFile(cfg: SmbConfig): void {
  const content = `username=${cfg.username}\npassword=${cfg.password}\ndomain=${cfg.domain}\n`;
  fs.writeFileSync(CRED_PATH, content, { mode: 0o600 });
  try { fs.chmodSync(CRED_PATH, 0o600); } catch { /* best-effort */ }
}
