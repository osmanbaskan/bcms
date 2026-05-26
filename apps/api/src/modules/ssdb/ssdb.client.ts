/**
 * SSDB MAM SQL Server read-only client — lazy singleton pool + parameterized
 * query helper.
 *
 * Read-only NIYET: bu client INSERT/UPDATE/DELETE/EXEC desteklemez kod yolu
 * acisindan (caller'in disipline bagli). Gercek read-only KORUMA SQL kullanici
 * yetkisinden gelir (SSDB `read1` user GRANT SELECT only). Server-side reject
 * V1 guvenligin kanonik katmani.
 *
 * V1 TLS:
 *   encrypt: true                  -> trafik sifreli
 *   trustServerCertificate: true   -> self-signed kabul (sqlcmd `-C` davranisi)
 * SSDB cert chain'i kurumsal CA ile imzalandiginda V2'de trust kaldirilabilir;
 * V1 sozlesmesi guvenli kabul edildi (kullanici onayli SQL kullanicisi + TLS).
 *
 * Lazy: config.enabled === false iken `getSsdbPool()` cagrildigi anda
 * `assertSsdbConfigReady` Error firlatir; pool olusturulmaz. Production
 * disabled state'de mssql connect hic denenmez.
 */

import sql from 'mssql';
import { loadSsdbConfig, assertSsdbConfigReady, type SsdbConfig } from './ssdb.config.js';

let pool: sql.ConnectionPool | null = null;
let connectPromise: Promise<sql.ConnectionPool> | null = null;
/**
 * Son basarili config — sifre redact pattern'i icin tutulur. Bu modulden
 * disari verilmez; sadece sanitize() icinde kullanilir.
 */
let cachedConfig: SsdbConfig | null = null;

function buildMssqlConfig(c: SsdbConfig): sql.config {
  // Tum required alanlar `assertSsdbConfigReady` ile dolu garantili —
  // bu noktada `!` non-null assertion guvenli.
  return {
    server:   c.host!,
    port:     c.port!,
    database: c.database!,
    user:     c.user!,
    password: c.password!,
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
    pool: { max: c.poolMax, min: c.poolMin },
    connectionTimeout: c.connectTimeoutMs,
    requestTimeout:    c.requestTimeoutMs,
  };
}

/**
 * Hata mesajinda sifre degeri varsa redact. mssql bazen "ConnectionPool config:
 * { ..., password: '...' }" benzeri dump uretir; bu defensif filtre.
 */
function sanitize(message: string): string {
  if (!cachedConfig?.password) return message;
  const pw = cachedConfig.password;
  const re = new RegExp(pw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return message.replace(re, '***');
}

/**
 * Lazy singleton SSDB pool. Connect timeout ve pool size config'ten gelir.
 * Aynı anda birden cok caller ilk pool acilisinda concurrent gelirse
 * `connectPromise` ile race korunur — ikinci caller mevcut promise'i bekler.
 */
export async function getSsdbPool(config?: SsdbConfig): Promise<sql.ConnectionPool> {
  const c = config ?? cachedConfig ?? loadSsdbConfig();
  cachedConfig = c;
  assertSsdbConfigReady(c);

  if (pool && pool.connected) return pool;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      const p = new sql.ConnectionPool(buildMssqlConfig(c));
      await p.connect();
      pool = p;
      return p;
    } catch (err) {
      const raw = (err as Error)?.message ?? String(err);
      throw new Error(`SSDB pool connect failed: ${sanitize(raw)}`);
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

/** Parametre bind girisi — name + sql.* type + value. */
export interface SsdbQueryParam {
  name: string;
  type: sql.ISqlTypeFactoryWithNoParams | sql.ISqlType;
  value: unknown;
}

/**
 * Parameterized read-only SSDB query helper.
 *
 * Tum parametreler `request.input(name, type, value)` ile bind edilir;
 * string concat ile inline injection ASLA yapilmaz. SQL gov'erine `@name`
 * placeholder yazilir.
 *
 * `poolFactory` opsiyonu test/injection icin — default `getSsdbPool` kullanir.
 * Production caller'lari `poolFactory` gecmesin; default lazy singleton hep
 * dogrudur.
 */
export async function querySsdb<T = unknown>(
  query: string,
  params: SsdbQueryParam[] = [],
  poolFactory: () => Promise<sql.ConnectionPool> = getSsdbPool,
): Promise<T[]> {
  const p = await poolFactory();
  const req = p.request();
  for (const param of params) {
    // mssql `input` overload'lari icin cast — type, ISqlType OR ISqlTypeFactory.
    req.input(param.name, param.type as sql.ISqlType, param.value);
  }
  const result = await req.query<T>(query);
  return result.recordset as unknown as T[];
}

/** Test ve graceful-shutdown icin — runtime'da elle cagirma. */
export async function closeSsdbPool(): Promise<void> {
  const p = pool;
  pool = null;
  connectPromise = null;
  cachedConfig = null;
  if (p) {
    try { await p.close(); } catch { /* idempotent close */ }
  }
}

/** SADECE test isolation icin — modul-state'i sifirlar. Production'da kullanma. */
export function _resetSsdbClientStateForTests(): void {
  pool = null;
  connectPromise = null;
  cachedConfig = null;
}

/** Test gozlemi icin — pool su an init edildi mi? */
export function _hasSsdbPoolForTests(): boolean {
  return pool !== null || connectPromise !== null;
}
