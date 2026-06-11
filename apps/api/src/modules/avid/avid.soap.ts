/**
 * Avid IPWS (Interplay Web Services) SOAP transport — saf, bağımlılıksız.
 *
 * IPWS = Avid'in SOAP/HTTP cephesi. Düz HTTP POST + XML ile konuşulur; SOAP
 * kütüphanesi gerekmez (PoC raporu §4 "[DOĞRULANDI]"). Bu modül yalnız
 * transport sağlar: envelope kur → POST → gövdeyi parse et → iş-hatası
 * (`<Errors>`/`<Fault>`) varsa fırlat. Servis-spesifik body XML'ini ve
 * sonuç eşlemesini çağıran (avid.client.ts) yapar.
 *
 * KRİTİK NAMESPACE TUZAĞI (rapor §3, [DOĞRULANDI]):
 *   `UserCredentials` HER ZAMAN assets/types namespace'indedir
 *   (`http://avid.com/interplay/ws/assets/types`) — çağrılan servis (Jobs/
 *   Transfer) kendi namespace'inde olsa bile. Bu yüzden envelope iki ns
 *   bildirir: `c:` = assets-credentials (sabit), `b:` = body namespace
 *   (servise göre değişir). K1 (Assets.Search) için ikisi de assets/types.
 *
 * GÜVENLİK: parola yalnız envelope gövdesine yazılır; hiçbir log/hata
 * mesajına sızmaz. Fırlatılan tüm Error mesajları `redact()`'ten geçer
 * (SSDB client pattern paritesi).
 */

import { XMLParser } from 'fast-xml-parser';
import type { AvidConfig } from './avid.config.js';

/** IPWS namespace sabitleri (rapor §5 referans tablosu). */
export const AVID_NS = {
  soapEnvelope: 'http://schemas.xmlsoap.org/soap/envelope/',
  /** UserCredentials HER ZAMAN burada (rapor §3). */
  assetsTypes: 'http://avid.com/interplay/ws/assets/types',
  jobsTypes: 'http://avid.com/interplay/ws/jobs/types',
} as const;

/** IPWS servis adları — endpoint path'i (`/services/<Service>`). */
export type AvidService = 'Assets' | 'Archive' | 'Transfer' | 'Jobs' | 'Infrastructure';

/**
 * SOAP/IPWS iş-hatası veya transport hatası. `code`:
 *  - IPWS `<Error Code="...">` değeri (örn. MEDIA_OFFLINE, INVALID_PARAMETER),
 *  - veya transport kodu: 'HTTP_ERROR' | 'TIMEOUT' | 'SOAP_FAULT' | 'PARSE_ERROR'.
 */
export class AvidSoapError extends Error {
  readonly code: string;
  readonly details?: string;
  constructor(code: string, message: string, details?: string) {
    super(message);
    this.name = 'AvidSoapError';
    this.code = code;
    this.details = details;
  }
}

/** XML metin-içeriği için minimal escape (envelope body kurarken). */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Hata mesajından parola değerini çıkar (defensif; SSDB sanitize paritesi). */
function redact(message: string, password: string | null): string {
  if (!password) return message;
  const re = new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  return message.replace(re, '***');
}

/** `AVID_INTERPLAY_URL` base'inden servis endpoint'i kurar. */
export function serviceEndpoint(baseUrl: string, service: AvidService): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return `${trimmed}/${service}`;
}

/**
 * Tam SOAP envelope'u kur. `bodyXml` zaten `b:` prefix'li body elemanını
 * içermeli (örn. `<b:Search>...</b:Search>`).
 */
export function buildEnvelope(params: {
  username: string;
  password: string;
  bodyNs: string;
  bodyXml: string;
}): string {
  const { username, password, bodyNs, bodyXml } = params;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${AVID_NS.soapEnvelope}" ` +
    `xmlns:c="${AVID_NS.assetsTypes}" ` +
    `xmlns:b="${bodyNs}">` +
    `<s:Header>` +
    `<c:UserCredentials>` +
    `<c:Username>${escapeXml(username)}</c:Username>` +
    `<c:Password>${escapeXml(password)}</c:Password>` +
    `</c:UserCredentials>` +
    `</s:Header>` +
    `<s:Body>${bodyXml}</s:Body>` +
    `</s:Envelope>`
  );
}

/** Namespace-agnostik parser — prefix'leri at (rapor §4: Avid ns varyasyonu döner). */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: true,
  trimValues: true,
});

/** Parse edilmiş ağaçta `Error`/`Fault` düğümü ara (recursive, ns-agnostik). */
function findErrorNode(node: unknown): { code: string; message: string; details?: string } | null {
  if (node == null || typeof node !== 'object') return null;

  const obj = node as Record<string, unknown>;

  // SOAP Fault (HTTP 500 yolu)
  if ('Fault' in obj && obj.Fault && typeof obj.Fault === 'object') {
    const f = obj.Fault as Record<string, unknown>;
    const faultString =
      (typeof f.faultstring === 'string' && f.faultstring) ||
      (typeof f.Reason === 'string' && f.Reason) ||
      'SOAP Fault';
    const faultCode =
      (typeof f.faultcode === 'string' && f.faultcode) || 'SOAP_FAULT';
    return { code: String(faultCode), message: String(faultString) };
  }

  // IPWS <Errors><Error Code="..."><Message>..</Message><Details>..</Details>
  if ('Error' in obj && obj.Error) {
    const errs = Array.isArray(obj.Error) ? obj.Error : [obj.Error];
    for (const e of errs) {
      if (e && typeof e === 'object') {
        const er = e as Record<string, unknown>;
        const code = typeof er['@_Code'] === 'string' ? er['@_Code'] : 'AVID_ERROR';
        const message = typeof er.Message === 'string' ? er.Message : 'Avid error';
        const details = typeof er.Details === 'string' ? er.Details : undefined;
        return { code, message, details };
      }
    }
  }

  // recurse
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findErrorNode(item);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findErrorNode(value);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Bir IPWS SOAP operasyonu çağır.
 *
 * @returns Parse edilmiş `<Body>` içeriği (ns-prefix'siz JS objesi). İş hatası
 *          (`<Errors>`/`<Fault>`) varsa `AvidSoapError` fırlatır.
 */
export async function postSoap(
  cfg: AvidConfig,
  params: { service: AvidService; bodyNs: string; bodyXml: string },
): Promise<Record<string, unknown>> {
  if (!cfg.interplayUrl || !cfg.user || cfg.password == null) {
    // assertAvidConfigReady caller tarafında çağrılmış olmalı; defensif.
    throw new AvidSoapError('CONFIG', 'Avid config incomplete (url/user/password)');
  }

  const endpoint = serviceEndpoint(cfg.interplayUrl, params.service);
  const envelope = buildEnvelope({
    username: cfg.user,
    password: cfg.password,
    bodyNs: params.bodyNs,
    bodyXml: params.bodyXml,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.requestTimeoutMs);

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        // Boş SOAPAction çalışıyor (rapor §4 [DOĞRULANDI]).
        SOAPAction: '""',
      },
      body: envelope,
      signal: controller.signal,
    });
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    const raw = err instanceof Error ? err.message : String(err);
    throw new AvidSoapError(
      isAbort ? 'TIMEOUT' : 'HTTP_ERROR',
      redact(isAbort ? `Avid request timed out after ${cfg.requestTimeoutMs}ms` : `Avid request failed: ${raw}`, cfg.password),
    );
  } finally {
    clearTimeout(timer);
  }

  // İş hataları HTTP 200'de <Errors>; protokol hataları HTTP 500 + <Fault>.
  // Her durumda gövdeyi oku ve parse et (rapor §4).
  const text = await res.text();

  let parsed: Record<string, unknown>;
  try {
    parsed = parser.parse(text) as Record<string, unknown>;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    throw new AvidSoapError(
      'PARSE_ERROR',
      redact(`Avid response parse failed (HTTP ${res.status}): ${raw}`, cfg.password),
    );
  }

  const errNode = findErrorNode(parsed);
  if (errNode) {
    throw new AvidSoapError(
      errNode.code,
      redact(`Avid ${errNode.code}: ${errNode.message}`, cfg.password),
      errNode.details,
    );
  }

  // Hata yok ama HTTP non-2xx ise yine de hata say.
  if (!res.ok) {
    throw new AvidSoapError('HTTP_ERROR', `Avid HTTP ${res.status} ${res.statusText}`);
  }

  // <Body> içeriğini döndür (ns-agnostik: Envelope.Body).
  const envelopeNode = parsed.Envelope as Record<string, unknown> | undefined;
  const bodyNode = envelopeNode?.Body as Record<string, unknown> | undefined;
  return bodyNode ?? parsed;
}
