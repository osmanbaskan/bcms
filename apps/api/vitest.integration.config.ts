import { defineConfig } from 'vitest/config';

// Backend integration test config.
//
// Bkz: ops/REQUIREMENTS-BACKEND-INTEGRATION-TESTS.md
//
// - Suite başı: prisma migrate reset (real PG via Testcontainers veya CI service)
// - Test sonrası: TRUNCATE cleanup (transactional tablolar)
// - Spec convention: src glob ile *.integration.spec.ts
// - Sequential pool: tek DB instance, paralel test izolasyonu yok (basit + güvenli)
export default defineConfig({
  test: {
    include: ['src/**/*.integration.spec.ts'],
    globals: true,
    environment: 'node',
    setupFiles: ['./test/integration/setup.ts'],
    // Tek tek çalıştır; aynı DB üzerinde paralel test = nondeterministic.
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 30_000,    // Testcontainers boot + migrate ~5-10sn
    hookTimeout: 60_000,    // beforeAll/afterAll için (container startup)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage/integration',
      include: [
        'src/plugins/audit.ts',
        'src/modules/schedules/schedule.service.ts',
        'src/modules/bookings/booking.service.ts',
      ],
    },
  },
});
