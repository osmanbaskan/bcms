import { defineConfig } from 'vitest/config';

// Backend unit test config — Testcontainers/Setup yok; saf pure-fn testleri.
// Bkz: vitest.integration.config.ts integration testleri için ayrıdır.
export default defineConfig({
  test: {
    include: ['src/**/*.unit.spec.ts'],
    globals: true,
    environment: 'node',
  },
});
