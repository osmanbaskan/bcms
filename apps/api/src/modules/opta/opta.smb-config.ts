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
  share:      '//beinfilesrv/BACKUPS',
  mountPoint: '/mnt/opta-backups',
  subdir:     'OPTAfromFTP20511',
  username:   '',
  password:   '',
  domain:     'OPTA_SMB_DOMAIN',
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
  writeCredFile(cfg);
}

function writeCredFile(cfg: SmbConfig): void {
  const content = `username=${cfg.username}\npassword=${cfg.password}\ndomain=${cfg.domain}\n`;
  fs.writeFileSync(CRED_PATH, content, { mode: 0o600 });
}
