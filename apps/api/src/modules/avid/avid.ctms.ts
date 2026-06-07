/**
 * Avid MediaCentral Cloud UX / CTMS REST transport — K3 transfer (submitSTPJob).
 *
 * IPWS SendToPlayback (avid.soap.ts) "Cannot import" verdiği için terk edildi:
 * çıplak longgopexport mixdown yapmaz, hazır media bekler. Cloud UX'in "transfer"
 * butonu ise CTMS `submitSTPJob` çağırır; arkadaki CDS Service mixdown + encode +
 * SendToPlayback'i KENDİ orkestra eder. 2026-06-01 HAR capture + BCMS'ten canlı
 * doğrulandı (job RUNNING→COMPLETED, MCR'ye indi).
 *
 *   POST {clouduxUrl}/apis/avid.pam.stp;version=1;realm={realm}/submitSTPJob
 *   Cookie: avidAccessToken={token}
 *   Body:   {"stpRequestDTO":{ device, profile, mobId, nodeId, processName,
 *                              videoId, burnGraphics:false, highPriority:false,
 *                              overwrite:false }}
 *   200:    {"errorSet":[], "responseData":"{\"jobId\":\"<uuid>\",
 *                              \"mcdsStatusURL\":\"https://mcds-host:8443/...\"}"}
 *
 * GÜVENLİK: `avidAccessToken` yalnız Cookie header'ına yazılır; hiçbir log/hata
 * mesajına sızmaz (redactToken). Self-signed TLS: yalnız bu modülün fetch
 * çağrıları sırasında `NODE_TLS_REJECT_UNAUTHORIZED=0` geçici set edilir ve
 * hemen eski değerine döndürülür (kalıcı global bypass YOK).
 */

import type { AvidConfig } from './avid.config.js';

/** CTMS REST iş/transport hatası. `code`: HTTP_ERROR | TIMEOUT | CTMS_ERROR | PARSE_ERROR | AUTH. */
export class AvidCtmsError extends Error {
  readonly code: string;
  readonly details?: string;
  constructor(code: string, message: string, details?: string) {
    super(message);
    this.name = 'AvidCtmsError';
    this.code = code;
    this.details = details;
  }
}

/** submitSTPJob için JSON gövde girdileri. */
export interface StpRequestInput {
  realm: string;
  mobId: string;
  processName: string;
  videoId: string;
  device: string;
  profile: string;
}

/** submitSTPJob başarı sonucu (responseData parse edilmiş). */
export interface StpSubmitResult {
  jobId: string;
  mcdsStatusURL?: string;
}

/** `avid.pam.stp` submitSTPJob endpoint'i (realm gömülü). */
export function submitStpJobEndpoint(clouduxUrl: string, realm: string): string {
  const base = clouduxUrl.replace(/\/+$/, '');
  return `${base}/apis/avid.pam.stp;version=1;realm=${realm}/submitSTPJob`;
}

/** Token uzatma endpoint'i (POST, Content-Length:0). */
export function tokenExtensionEndpoint(clouduxUrl: string): string {
  return `${clouduxUrl.replace(/\/+$/, '')}/auth/tokens/current/extension`;
}

/** Mevcut token bilgisi endpoint'i (GET → accessToken + iamToken.expiresAt). */
export function tokenCurrentEndpoint(clouduxUrl: string): string {
  return `${clouduxUrl.replace(/\/+$/, '')}/auth/tokens/current`;
}

/**
 * submitSTPJob gövdesini kur. `mobId` HAM sequence mob ID'sidir (companion
 * gerekmez; CDS kendi üretir). `nodeId` = interplay:{realm}:sequence:{mobId}.
 */
export function buildStpRequestBody(input: StpRequestInput): string {
  const { realm, mobId, processName, videoId, device, profile } = input;
  return JSON.stringify({
    stpRequestDTO: {
      device,
      burnGraphics: false,
      highPriority: false,
      overwrite: false,
      mobId,
      nodeId: `interplay:${realm}:sequence:${mobId}`,
      processName,
      profile,
      videoId,
    },
  });
}

/** Hata mesajından token değerini çıkar (defensif; avid.soap redact paritesi). */
function redactToken(message: string, token: string | null): string {
  if (!token) return message;
  const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return message.replace(re, '***');
}

/**
 * Self-signed TLS: insecure iken `NODE_TLS_REJECT_UNAUTHORIZED=0`'ı SADECE
 * verilen fetch çağrısı süresince set eder, hemen eski değerine döndürür.
 * Kalıcı global bypass yok; undici Agent bağımlılığı yok (container build uyumlu).
 */
async function fetchInsecure(cfg: AvidConfig, url: string, init: RequestInit): Promise<Response> {
  if (!cfg.clouduxInsecureTls) return fetch(url, init);
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fetch(url, init);
  } finally {
    if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
  }
}

/**
 * CTMS submitSTPJob çağır. Başarıda `{jobId, mcdsStatusURL}` döner; errorSet/errors
 * doluysa veya HTTP non-2xx ise `AvidCtmsError` fırlatır (token mesaja sızmaz).
 */
export async function postSubmitStpJob(
  cfg: AvidConfig,
  token: string,
  input: StpRequestInput,
): Promise<StpSubmitResult> {
  const endpoint = submitStpJobEndpoint(cfg.clouduxUrl, input.realm);
  const body = buildStpRequestBody(input);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  let res: Response;
  try {
    res = await fetchInsecure(cfg, endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        Cookie: `avidAccessToken=${token}`,
        Origin: cfg.clouduxUrl,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const raw = err instanceof Error ? err.message : String(err);
    throw new AvidCtmsError(
      isAbort ? 'TIMEOUT' : 'HTTP_ERROR',
      redactToken(
        isAbort ? `CTMS request timed out after ${cfg.requestTimeoutMs}ms` : `CTMS request failed: ${raw}`,
        token,
      ),
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw new AvidCtmsError('AUTH', `CTMS auth failed (HTTP ${res.status}) — avidAccessToken geçersiz/süresi dolmuş olabilir`);
  }
  if (!res.ok) {
    throw new AvidCtmsError('HTTP_ERROR', redactToken(`CTMS HTTP ${res.status} ${res.statusText}: ${text.slice(0, 300)}`, token));
  }

  let parsed: { errorSet?: unknown[]; errors?: unknown[]; responseData?: string };
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new AvidCtmsError('PARSE_ERROR', redactToken(`CTMS response parse failed: ${raw}`, token));
  }

  const errs = [...(parsed.errorSet ?? []), ...(parsed.errors ?? [])];
  if (errs.length > 0) {
    throw new AvidCtmsError('CTMS_ERROR', `CTMS submitSTPJob error: ${JSON.stringify(errs).slice(0, 300)}`);
  }

  // responseData iç-içe JSON string: {"jobId":"...","mcdsStatusURL":"..."}.
  let jobId: string | undefined;
  let mcdsStatusURL: string | undefined;
  if (typeof parsed.responseData === 'string') {
    try {
      const rd = JSON.parse(parsed.responseData) as { jobId?: string; mcdsStatusURL?: string };
      jobId = rd.jobId;
      mcdsStatusURL = rd.mcdsStatusURL;
    } catch {
      /* responseData parse edilemedi — jobId yok sayılır, aşağıda throw. */
    }
  }
  if (!jobId) {
    throw new AvidCtmsError('CTMS_ERROR', `CTMS submitSTPJob yanıtında jobId yok: ${text.slice(0, 300)}`);
  }
  return { jobId, mcdsStatusURL };
}

// ============================================================================
// ROPC login — kullanıcı/parola ile programatik avidAccessToken ÜRETİMİ.
// Saha (172.26.33.56): OAuth2/AD, identity-provider "ropc-default". Web app
// init.js'ten + canlı doğrulandı (2026-06-08):
//   POST {cloudux}/auth/sso/login/oauth2/ad
//   Authorization: Basic <clientBasic>          (web app'in gömülü public client'ı)
//   Content-Type: application/x-www-form-urlencoded
//   username&password&grant_type=password&no_refresh_token=true&scope=openid
//   → 200 Set-Cookie: avidAccessToken=... (TTL ~15dk; /extension ile uzatılır)
// ============================================================================

export interface RopcLoginResult {
  token: string;
  /** iamToken.expiresAt epoch-ms; okunamadıysa null. */
  expiresAtMs: number | null;
}

/** ROPC login endpoint'i (identity-provider "ropc-default" / "ropc-ad"). */
export function ropcLoginEndpoint(clouduxUrl: string): string {
  return `${clouduxUrl.replace(/\/+$/, '')}/auth/sso/login/oauth2/ad`;
}

/** Response Set-Cookie başlık(lar)ından avidAccessToken değerini çıkar. */
function extractCookieToken(res: Response): string | null {
  const getter = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const cookies = typeof getter === 'function'
    ? getter.call(res.headers)
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie') as string] : []);
  for (const c of cookies) {
    const m = c.match(/avidAccessToken=([^;]+)/);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** Yanıt JSON'undan iamToken.expiresAt → epoch-ms (yoksa null). */
function parseExpiryMs(j: unknown): number | null {
  if (!j || typeof j !== 'object') return null;
  const iam = (j as { iamToken?: { expiresAt?: string } }).iamToken;
  if (iam && typeof iam.expiresAt === 'string') {
    const ms = Date.parse(iam.expiresAt);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** GET /auth/tokens/current → iamToken.expiresAt oku (token doğrulama da yapar). */
async function fetchTokenExpiry(cfg: AvidConfig, token: string): Promise<number | null> {
  try {
    const res = await fetchInsecure(cfg, tokenCurrentEndpoint(cfg.clouduxUrl), {
      method: 'GET',
      headers: { Accept: 'application/json', Cookie: `avidAccessToken=${token}` },
    });
    if (!res.ok) return null;
    return parseExpiryMs(await res.json());
  } catch { return null; }
}

/**
 * ROPC login → taze avidAccessToken üret. Başarıda {token, expiresAtMs}; 401/403
 * veya token yoksa AvidCtmsError(AUTH). Parola/token log/hata mesajına SIZMAZ.
 */
export async function postRopcLogin(
  cfg: AvidConfig,
  opts: { username: string; password: string; clientBasic: string },
): Promise<RopcLoginResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
  const form = new URLSearchParams({
    username: opts.username,
    password: opts.password,
    grant_type: 'password',
    no_refresh_token: 'true',
    scope: 'openid',
  });
  let res: Response;
  try {
    res = await fetchInsecure(cfg, ropcLoginEndpoint(cfg.clouduxUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${opts.clientBasic}`,
        Origin: cfg.clouduxUrl,
      },
      body: form.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    throw new AvidCtmsError(
      isAbort ? 'TIMEOUT' : 'HTTP_ERROR',
      isAbort
        ? `CTMS login timed out after ${cfg.requestTimeoutMs}ms`
        : `CTMS login request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AvidCtmsError('AUTH', `CTMS login reddedildi (HTTP ${res.status}) — kullanıcı/parola veya client kimliği geçersiz`);
  }

  let token = extractCookieToken(res);
  let expiresAtMs: number | null = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const j = JSON.parse(text) as { accessToken?: string };
      if (!token && typeof j.accessToken === 'string') token = j.accessToken;
      expiresAtMs = parseExpiryMs(j);
    } catch { /* gövde JSON değil — token cookie'den gelmiş olabilir */ }
  }
  if (!token) {
    throw new AvidCtmsError('AUTH', `CTMS login yanıtında avidAccessToken yok (HTTP ${res.status})`);
  }
  if (expiresAtMs == null) {
    expiresAtMs = await fetchTokenExpiry(cfg, token);
  }
  return { token, expiresAtMs };
}

// ============================================================================
// Token yöneticisi — ROPC login ile token ÜRETİR + /extension ile canlı tutar +
// süresi dolunca/401'de YENİDEN login (self-healing). Elle token yapıştırma yok.
// ============================================================================

export interface CtmsTokenManager {
  /** Geçerli token (senkron, mevcut değer). */
  getToken(): string;
  /** Geçerli+süresi olan token döndür; yoksa/expiring ise ROPC login eder. */
  ensureToken(): Promise<string>;
  /** Token'ı zorla yenile (401 sonrası): yeniden ROPC login. */
  forceRelogin(): Promise<string>;
  /** Periyodik uzatma/yenileme başlat (idempotent). */
  start(): void;
  /** Timer'ı durdur (shutdown / test). */
  stop(): void;
  /** Tek seferlik uzatma denemesi (test/manuel). */
  extendOnce(): Promise<boolean>;
}

/**
 * Token yöneticisi (self-healing). Token ROPC login ile ÜRETİLİR
 * (`postRopcLogin`, kullanıcı/parola → avidAccessToken). Arka planda `intervalMs`
 * (default 10 dk; TTL ~15 dk) ile `/extension` POST eder; extension başarısız
 * olur/token ölürse YENİDEN login eder. `cfg.clouduxToken` set ise başlangıçta
 * seed olur (legacy/manuel); yine de 401'de re-login devreye girer.
 *
 * Login creds: `cfg.clouduxUser/clouduxPassword` (yoksa IPWS `user/password`) +
 * `cfg.clouduxClientBasic` (gömülü public OAuth client). Süreç restart / boşta
 * kalma sonrası insan müdahalesi GEREKMEZ.
 */
export function createCtmsTokenManager(
  cfg: AvidConfig,
  opts: { intervalMs?: number; logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void } } = {},
): CtmsTokenManager {
  let token = cfg.clouduxToken ?? '';
  let expiresAtMs: number | null = null; // login/extend'den gelir; seed token için bilinmez
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000; // 10 dk
  const skewMs = 60_000; // expiry'den 1 dk önce yenile
  const log = opts.logger;
  let timer: NodeJS.Timeout | null = null;
  let loginInFlight: Promise<string> | null = null;

  const canLogin = (): boolean =>
    !!cfg.clouduxClientBasic && !!(cfg.clouduxUser ?? cfg.user) && !!(cfg.clouduxPassword ?? cfg.password);

  async function doLogin(): Promise<string> {
    if (!canLogin()) {
      if (token) return token; // login yapılamıyor ama seed token var
      throw new AvidCtmsError('AUTH', 'CTMS login config eksik (client Basic / kullanıcı / parola) ve token yok');
    }
    const r = await postRopcLogin(cfg, {
      username: (cfg.clouduxUser ?? cfg.user) as string,
      password: (cfg.clouduxPassword ?? cfg.password) as string,
      clientBasic: cfg.clouduxClientBasic as string,
    });
    token = r.token;
    expiresAtMs = r.expiresAtMs;
    log?.info({ expiresAtMs }, 'CTMS ROPC login OK (token üretildi)');
    return token;
  }

  /** Eşzamanlı login stampede'ini önle (tek uçuş). */
  function loginSingleFlight(): Promise<string> {
    if (!loginInFlight) {
      loginInFlight = doLogin().finally(() => { loginInFlight = null; });
    }
    return loginInFlight;
  }

  async function extendOnce(): Promise<boolean> {
    if (!token) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);
    try {
      const res = await fetchInsecure(cfg, tokenExtensionEndpoint(cfg.clouduxUrl), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Length': '0',
          Cookie: `avidAccessToken=${token}`,
          Origin: cfg.clouduxUrl,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        log?.warn({ status: res.status }, 'CTMS token extension failed');
        return false;
      }
      // accessToken rotate olabilir + expiresAt güncellenir.
      try {
        const j = (await res.json()) as { accessToken?: string; iamToken?: { expiresAt?: string } };
        if (typeof j.accessToken === 'string' && j.accessToken) token = j.accessToken;
        const ms = parseExpiryMs(j);
        if (ms != null) expiresAtMs = ms;
      } catch { /* gövde okunamadı — token aynı kalır */ }
      return true;
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      log?.warn({ err: redactToken(raw, token) }, 'CTMS token extension error');
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    getToken: () => token,

    async ensureToken(): Promise<string> {
      const fresh = !!token && (expiresAtMs == null || Date.now() < expiresAtMs - skewMs);
      if (fresh) return token;
      return loginSingleFlight();
    },

    async forceRelogin(): Promise<string> {
      token = '';
      expiresAtMs = null;
      return loginSingleFlight();
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        void (async () => {
          const ok = await extendOnce();
          if (!ok && canLogin()) { await loginSingleFlight().catch(() => {}); }
        })();
      }, intervalMs);
      timer.unref?.();
      log?.info({ intervalMs }, 'CTMS token manager started (login + extend self-heal)');
    },

    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },

    extendOnce,
  };
}
