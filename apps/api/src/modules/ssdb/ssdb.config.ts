/**
 * SSDB MAM SQL Server resolver runtime config — env tabanli, saf.
 *
 * Feature flag (`PROVYS_SSDB_RESOLVER`) default OFF; kapali iken eksik
 * env'ler hata vermez (sadece okur). Acik iken `assertSsdbConfigReady`
 * tum zorunlu alanlari kontrol eder; eksik varsa fail-fast.
 *
 * Sifre (`SSDB_PASSWORD`) bu modulden disari yalnizca dondurulen
 * `SsdbConfig.password` alani uzerinden gecer. Bu modul hicbir log/error
 * mesajinda sifre degerini gostermemelidir; hata mesajlari sadece env
 * adlarini listeler.
 *
 * Bu modul side-effect'siz: top-level `process.env` okumaz. `loadSsdbConfig`
 * cagrildiginda env okunur (default `process.env`, test'te override edilir).
 */

export interface SsdbConfig {
  /** Feature flag: PROVYS_SSDB_RESOLVER on/true/1/yes -> true. */
  enabled: boolean;
  host: string | null;
  /** Numeric port 1-65535; non-numeric/out-of-range -> null. */
  port: number | null;
  database: string | null;
  user: string | null;
  password: string | null;
  defaultFps: number;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  poolMax: number;
  poolMin: number;
}

function parseBoolEnv(v: string | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'on';
}

function parsePositiveIntEnv(v: string | undefined, fallback: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

function parseNonNegativeIntEnv(v: string | undefined, fallback: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback;
  return n;
}

function parsePortEnv(v: string | undefined): number | null {
  if (!v || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

/** Env -> SsdbConfig. Validation YAPMAZ; sadece parse eder. */
export function loadSsdbConfig(env: NodeJS.ProcessEnv = process.env): SsdbConfig {
  return {
    enabled: parseBoolEnv(env.PROVYS_SSDB_RESOLVER),
    host: env.SSDB_HOST?.trim() || null,
    port: parsePortEnv(env.SSDB_PORT),
    database: env.SSDB_DATABASE?.trim() || null,
    user: env.SSDB_USER?.trim() || null,
    // Password trim YAPMA — bazi sifreler bilerek bosluk icerir; raw kabul.
    password: env.SSDB_PASSWORD && env.SSDB_PASSWORD !== '' ? env.SSDB_PASSWORD : null,
    defaultFps:       parsePositiveIntEnv(env.SSDB_DEFAULT_FPS, 25),
    connectTimeoutMs: parsePositiveIntEnv(env.SSDB_CONNECT_TIMEOUT_MS, 10000),
    requestTimeoutMs: parsePositiveIntEnv(env.SSDB_REQUEST_TIMEOUT_MS, 10000),
    poolMax:          parsePositiveIntEnv(env.SSDB_POOL_MAX, 2),
    poolMin:          parseNonNegativeIntEnv(env.SSDB_POOL_MIN, 0),
  };
}

/**
 * Resolver acikken zorunlu env'lerin doluluk kontrolu. Eksik varsa Error
 * firlatir; mesaj SADECE env adlarini icerir (sifre degeri ASLA).
 *
 * Resolver kapaliyken cagrilirsa explicit "disabled" hatasi — caller
 * yanlislikla pool acmaya calismasin.
 */
export function assertSsdbConfigReady(config: SsdbConfig): void {
  if (!config.enabled) {
    throw new Error(
      'SSDB resolver is disabled (PROVYS_SSDB_RESOLVER != on); SSDB client cannot be used.',
    );
  }
  const missing: string[] = [];
  if (!config.host)     missing.push('SSDB_HOST');
  if (config.port == null) missing.push('SSDB_PORT');
  if (!config.database) missing.push('SSDB_DATABASE');
  if (!config.user)     missing.push('SSDB_USER');
  if (!config.password) missing.push('SSDB_PASSWORD');
  if (missing.length > 0) {
    // SADECE env adlari — sifre degeri ASLA mesajda gorunmez.
    throw new Error(`SSDB config missing required env: ${missing.join(', ')}`);
  }
  if (config.defaultFps <= 0) {
    throw new Error('SSDB_DEFAULT_FPS must be a positive integer');
  }
}
