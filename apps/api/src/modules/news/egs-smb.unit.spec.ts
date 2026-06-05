import { describe, it, expect } from 'vitest';
import { parseSmbUrl } from './egs-smb.js';

describe('parseSmbUrl', () => {
  it('host/share/dir ayrıştırır', () => {
    expect(parseSmbUrl('smb://172.26.33.245/mcr/EGS/')).toEqual({ host: '172.26.33.245', share: 'mcr', dir: 'EGS' });
    expect(parseSmbUrl('smb://srv/mcr/EGS/2026')).toEqual({ host: 'srv', share: 'mcr', dir: 'EGS/2026' });
  });
  it('dizinsiz paylaşım → dir boş', () => {
    expect(parseSmbUrl('smb://172.26.33.245/mcr')).toEqual({ host: '172.26.33.245', share: 'mcr', dir: '' });
    expect(parseSmbUrl('smb://172.26.33.245/mcr/')).toEqual({ host: '172.26.33.245', share: 'mcr', dir: '' });
  });
  it('geçersiz yol → hata', () => {
    expect(() => parseSmbUrl('http://x/y')).toThrow();
    expect(() => parseSmbUrl('smb://onlyhost')).toThrow();
  });
});
