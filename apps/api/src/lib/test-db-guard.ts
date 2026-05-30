/**
 * Test DB güvenlik guard'ı (K1+, 2026-05-30).
 *
 * Integration testlerindeki YIKICI işlemler — `prisma db push --force-reset`
 * (setup.ts; şemayı siler) ve `TRUNCATE ... CASCADE` (helpers.ts cleanup) —
 * yanlış yapılandırılmış bir DATABASE_URL ile canlı/prod DB'ye karşı çalışırsa
 * felakettir (bkz. 2026-05-29 TRUNCATE incident).
 *
 * Pür fonksiyon; ALLOWLIST uygular: yalnız (a) local host
 * (localhost/127.0.0.1/::1/host.docker.internal) VEYA (b) adı "test" içeren DB
 * kabul edilir. Aksi halde hard-fail. Hem testcontainers (localhost/bcms_test)
 * hem CI (TEST_DATABASE_URL=...@localhost:5433/bcms_test) geçer; uzak + prod-adlı
 * bir DB reddedilir.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

export function assertTestDatabaseUrl(rawUrl: string | undefined, op: string): void {
  const raw = (rawUrl ?? '').trim();
  if (!raw) {
    throw new Error(`${op} reddedildi: DATABASE_URL boş/tanımsız (test DB güvenlik guard'ı).`);
  }

  let host: string;
  let db: string;
  try {
    const u = new URL(raw);
    host = u.hostname.toLowerCase();
    db = decodeURIComponent(u.pathname).replace(/^\/+/, '').toLowerCase();
  } catch {
    throw new Error(`${op} reddedildi: DATABASE_URL ayrıştırılamadı.`);
  }

  const redacted = raw.replace(/:\/\/[^@/]+@/, '://***@');

  // Belirgin prod göstergeleri (fazladan emniyet — allowlist'ten önce).
  if (host === 'bcms_postgres' || host.startsWith('prod-') || host.startsWith('prod.')) {
    throw new Error(`${op} reddedildi: prod-benzeri host ("${redacted}").`);
  }

  const hostIsLocal = LOCAL_HOSTS.has(host);
  const dbLooksLikeTest = /(^|[_-])test([_-]|$)/.test(db) || db.endsWith('_test');

  if (!hostIsLocal && !dbLooksLikeTest) {
    throw new Error(
      `${op} reddedildi: canlı-DB koruması (K1+). DATABASE_URL ne local host ne de ` +
      `test DB adı içeriyor ("${redacted}"). Yalnız testcontainers/CI test DB'sine izin var.`,
    );
  }
}
