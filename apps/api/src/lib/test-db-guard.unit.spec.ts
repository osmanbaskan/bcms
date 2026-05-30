import { describe, expect, it } from 'vitest';
import { assertTestDatabaseUrl } from './test-db-guard.js';

const OP = 'test';

describe('assertTestDatabaseUrl', () => {
  it('testcontainers localhost + bcms_test → kabul', () => {
    expect(() => assertTestDatabaseUrl('postgresql://bcms_test:bcms_test@localhost:49153/bcms_test', OP)).not.toThrow();
  });
  it('CI TEST_DATABASE_URL (localhost:5433/bcms_test) → kabul', () => {
    expect(() => assertTestDatabaseUrl('postgresql://bcms_test:bcms_test@localhost:5433/bcms_test', OP)).not.toThrow();
  });
  it('127.0.0.1 → kabul', () => {
    expect(() => assertTestDatabaseUrl('postgresql://u:p@127.0.0.1:5432/anything', OP)).not.toThrow();
  });
  it('uzak host + test DB adı → kabul', () => {
    expect(() => assertTestDatabaseUrl('postgresql://u:p@db.ci.internal:5432/bcms_test', OP)).not.toThrow();
  });
  it('uzak host + prod-adlı DB → RED', () => {
    expect(() => assertTestDatabaseUrl('postgresql://bcms_user:changeme@10.0.0.5:5432/bcms', OP)).toThrow(/canlı-DB koruması/);
  });
  it('bcms_postgres host → RED', () => {
    expect(() => assertTestDatabaseUrl('postgresql://bcms_user:changeme@bcms_postgres:5432/bcms', OP)).toThrow(/prod-benzeri/);
  });
  it('boş / undefined → RED', () => {
    expect(() => assertTestDatabaseUrl('', OP)).toThrow();
    expect(() => assertTestDatabaseUrl(undefined, OP)).toThrow();
  });
  it('ayrıştırılamayan → RED', () => {
    expect(() => assertTestDatabaseUrl('not-a-url', OP)).toThrow();
  });
});
