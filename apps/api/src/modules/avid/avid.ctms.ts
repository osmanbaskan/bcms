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
 *                              \"mcdsStatusURL\":\"https://bsvmstp01:8443/...\"}"}
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
// Token yöneticisi — env'den alınan avidAccessToken'ı /extension ile canlı tutar.
// ============================================================================

export interface CtmsTokenManager {
  /** Geçerli (canlı tutulan) token. */
  getToken(): string;
  /** Periyodik uzatmayı başlat (idempotent). */
  start(): void;
  /** Uzatma timer'ını durdur (shutdown / test). */
  stop(): void;
  /** Tek seferlik uzatma denemesi (test/manuel). */
  extendOnce(): Promise<boolean>;
}

/**
 * Token yöneticisi. Başlangıç token'ı `cfg.clouduxToken`'dan gelir; arka planda
 * `intervalMs` (default ~10 dk; HAR: expiresIn ~899s ≈ 15 dk) ile
 * `/auth/tokens/current/extension` POST ederek süreyi uzatır. Token DEĞERİ
 * değişmez (aynı opaque token, süresi uzar) — Cloud UX davranışı.
 *
 * ⚠️ V1 sınırı: süreç yeniden başlar/token tamamen ölürse elle yenileme gerekir
 * (env güncelle). Prod için service account + OAuth2 login sonraki faz.
 */
export function createCtmsTokenManager(
  cfg: AvidConfig,
  opts: { intervalMs?: number; logger?: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void } } = {},
): CtmsTokenManager {
  let token = cfg.clouduxToken ?? '';
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000; // 10 dk
  const log = opts.logger;
  let timer: NodeJS.Timeout | null = null;

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
      // Yanıtta accessToken aynı kalır; yine de varsa güncelle (rotate ihtimaline karşı).
      try {
        const j = (await res.json()) as { accessToken?: string };
        if (typeof j.accessToken === 'string' && j.accessToken) token = j.accessToken;
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
    start() {
      if (timer) return;
      timer = setInterval(() => { void extendOnce(); }, intervalMs);
      timer.unref?.();
      log?.info({ intervalMs }, 'CTMS token manager started');
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    extendOnce,
  };
}
