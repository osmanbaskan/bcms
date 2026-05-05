import { execSync } from 'node:child_process';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll } from 'vitest';
import { disconnectPrisma, seedTestFixtures } from './helpers.js';

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
  // Not: `migrate reset` BCMS migration baseline sorunundan dolayı (eski tablolar
  // baseline'da yok, sadece increment migration'lar var) fresh DB'de çalışmaz.
  // Bkz: ops/REQUIREMENTS-MIGRATION-BASELINE.md.
  // `db push` schema.prisma'dan direkt schema oluşturur — test için doğru.
  execSync('npx prisma db push --skip-generate --accept-data-loss --force-reset', {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  // Minimal seed
  await seedTestFixtures();
});

afterAll(async () => {
  await disconnectPrisma();
  if (container) await container.stop();
});
