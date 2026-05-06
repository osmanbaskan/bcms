import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll } from 'vitest';
import { applyOutboxConstraints, applyOutboxIdempotencyIndex, applyTestConstraints, disconnectPrisma, seedTestFixtures } from './helpers.js';

/**
 * Hybrid setup:
 *   - Lokal geliştirici: Testcontainers spin postgres:16-alpine.
 *   - CI: TEST_DATABASE_URL env'i set edilir (GH Actions service postgres);
 *     Testcontainers atlanır.
 *
 * Suite başı: prisma migrate reset --force --skip-seed --skip-generate.
 * Sonrasında minimal seed (test fixtures: channels, leagues, broadcast_types).
 *
 * afterEach cleanup: helpers.ts → cleanupTransactional() per spec dosyasında çağrılır.
 */

let container: StartedPostgreSqlContainer | null = null;

beforeAll(async () => {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    // Lokal: testcontainers spin
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('bcms_test')
      .withUsername('bcms_test')
      .withPassword('bcms_test')
      .start();
    databaseUrl = container.getConnectionUri();
  }

  // Prisma client'ı bu URL'e bağla.
  process.env.DATABASE_URL = databaseUrl;
  process.env.NODE_ENV = 'test';

  // Schema sync — clean slate.
  //
  // ⚠️  INTERIM (2026-05-04): `prisma migrate reset` yerine `db push --force-reset`.
  //     Bunun sebebi BCMS migration baseline sorunu — eski tablolar (schedules,
  //     bookings, leagues vb.) baseline'da YOK, sadece incremental migration'lar var.
  //     Fresh DB'de migrate reset, ilk increment'i çalıştırırken "schedules
  //     tablosu yok" hatası verir.
  //
  //     Plan: Madde 1 (audit doc skip listesi) — AuditLog partition + migration
  //     baseline yeniden temellendirme PR'ı sonrası, bu satır geri
  //     `prisma migrate reset --force --skip-seed --skip-generate`'e döner.
  //
  //     Bkz: ops/REQUIREMENTS-MIGRATION-BASELINE.md
  //          ops/REQUIREMENTS-BACKEND-INTEGRATION-TESTS.md §5
  execSync('npx prisma db push --skip-generate --accept-data-loss --force-reset', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  // Madde 4 + Madde 2+7 PR-A interim: production CHECK constraint'leri
  // manuel reapply (db push schema.prisma'dan oluşturuyor; CHECK schema'da yok).
  await applyTestConstraints();
  await applyOutboxConstraints();
  // Madde 2+7 PR-B3b-2 schema PR: idempotency_key partial UNIQUE index reapply
  // (db push partial unique attribute'unu üretmez; bilinçli olarak schema.prisma'da
  // sadece nullable field var).
  await applyOutboxIdempotencyIndex();

  // Minimal seed
  await seedTestFixtures();
});

afterAll(async () => {
  await disconnectPrisma();
  if (container) await container.stop();
});
