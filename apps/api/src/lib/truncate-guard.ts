/**
 * Test DB TRUNCATE güvenlik kontrolü — saf, bağımlılıksız (unit test edilebilir).
 *
 * Integration testlerinin `cleanupTransactional` afterEach TRUNCATE'i yanlışlıkla
 * CANLI/prod DB'ye karşı çalıştırılırsa tüm operasyonel veri silinir.
 *
 * Olay geçmişi:
 *  - K1 (2026-05-29): ilk TRUNCATE incident → NODE_ENV + `@bcms_postgres` host guard.
 *  - 2026-06-01: integration suite `localhost:5433/bcms` (host-mapped port) ile
 *    çalıştırıldı; eski guard yalnız `@bcms_postgres` host'unu engellediği için
 *    AÇIK kaldı → lookup'lar + technical_details + schedules silindi. Bu guard o
 *    açığı (localhost/127.0.0.1:5433 + db adı "bcms") kapatır.
 *
 * TRUNCATE'ten ÖNCE çağrılır; hedef gerçek bir TEST DB değilse hard-fail eder.
 */

/** Canlı/prod DB göstergeleri — herhangi biri eşleşirse TRUNCATE reddedilir. */
const LIVE_DB_INDICATORS: readonly RegExp[] = [
  /@(bcms_postgres|prod-)/i,            // docker iç host adı / prod-* host
  /@(localhost|127\.0\.0\.1):5433\b/i, // canlı host-mapped port (2026-06-01 açığı)
  /\/bcms(\?|$)/i,                      // db adı tam "bcms" (canlı; test DB 'bcms_test')
];

/**
 * NODE_ENV 'test' değilse veya DATABASE_URL canlı/prod-benzeri bir DB'ye işaret
 * ediyorsa Error fırlatır. Aksi halde sessizce döner (güvenli test DB).
 */
export function assertSafeTruncateTarget(
  nodeEnv: string | undefined,
  databaseUrl: string,
): void {
  if (nodeEnv !== 'test') {
    throw new Error(
      `TRUNCATE reddedildi: NODE_ENV="${nodeEnv ?? 'undefined'}", beklenen "test". ` +
      `Integration spec'i vitest.integration.config.ts olmadan mı çalıştırdın? (K1)`,
    );
  }
  const offending = LIVE_DB_INDICATORS.find((re) => re.test(databaseUrl));
  if (offending) {
    const masked = databaseUrl.replace(/:\/\/[^@]+@/, '://***@');
    throw new Error(
      `TRUNCATE reddedildi: DATABASE_URL canlı/prod-benzeri DB'ye işaret ediyor ("${masked}"). ` +
      `Test ayrı bir DB'ye bağlanmalı (örn. bcms_test). (K1 + 2026-06-01 localhost:5433/bcms açığı)`,
    );
  }
}
