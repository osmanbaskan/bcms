import { describe, it, expect } from 'vitest';
import { assertSafeTruncateTarget } from './truncate-guard.js';

/**
 * K1 TRUNCATE guard — 2026-06-01 localhost:5433/bcms incident regresyon kilidi.
 * Eski guard yalnız `@bcms_postgres` host'unu engelliyordu; canlı DB host-mapped
 * port (localhost:5433) ile erişilince TRUNCATE canlıya gitti. Bu testler o
 * açığın kapalı kaldığını garantiler.
 */
describe('assertSafeTruncateTarget — canlı DB TRUNCATE guard', () => {
  // testcontainers: bcms_test, rastgele localhost portu → GÜVENLİ
  const TEST_OK = 'postgresql://bcms_test:bcms_test@localhost:54219/bcms_test';

  it('2026-06-01 açığı: localhost:5433/bcms → hard-fail', () => {
    expect(() => assertSafeTruncateTarget('test',
      'postgresql://bcms_user:changeme_db@localhost:5433/bcms')).toThrow(/reddedildi/);
  });

  it('127.0.0.1:5433/bcms → hard-fail', () => {
    expect(() => assertSafeTruncateTarget('test',
      'postgresql://u:p@127.0.0.1:5433/bcms')).toThrow(/reddedildi/);
  });

  it('docker iç host @bcms_postgres → hard-fail (K1)', () => {
    expect(() => assertSafeTruncateTarget('test',
      'postgresql://bcms_user:pw@bcms_postgres:5432/bcms')).toThrow(/reddedildi/);
  });

  it('db adı tam "bcms" (farklı host/port) → hard-fail', () => {
    expect(() => assertSafeTruncateTarget('test',
      'postgresql://u:p@db.internal:5432/bcms')).toThrow(/reddedildi/);
  });

  it('NODE_ENV != test → hard-fail', () => {
    expect(() => assertSafeTruncateTarget('production', TEST_OK)).toThrow(/NODE_ENV/);
    expect(() => assertSafeTruncateTarget(undefined, TEST_OK)).toThrow(/NODE_ENV/);
  });

  it('gerçek test DB (bcms_test, rastgele port) → GEÇER (throw etmez)', () => {
    expect(() => assertSafeTruncateTarget('test', TEST_OK)).not.toThrow();
  });

  it('CI test DB (bcms_test, başka host) → GEÇER', () => {
    expect(() => assertSafeTruncateTarget('test',
      'postgresql://ci:ci@postgres-ci:5432/bcms_test')).not.toThrow();
  });
});
