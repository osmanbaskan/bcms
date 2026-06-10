/**
 * Avid MediaCentral Capture Web Service — SALT-OKUMA istemci (Faz 0).
 *
 * ⛔ Bu dosyada Capture'a YAZAN hiçbir fonksiyon YOKTUR ve bu fazda YAZILAMAZ
 *    (2026-06-10 kesin emir: canlı Capture; create/modify/delete kodu Faz 3'te,
 *    kontrollü test gününde ayrı PR ile gelir).
 *
 * Mevcut yetenekler (hepsi okuma):
 *  - tcpProbe   : host:port'a TCP connect (istek yok, soket aç-kapa).
 *  - fetchWsdl  : GET {wsUrl}?wsdl — şema okuma; kayıt verisine dokunmaz.
 *  - extractWsdlOperations / classifyOperation : WSDL'den operasyon envanteri
 *    (read/write sınıflama — yarınki keşif raporu için).
 *
 * Tüm çağrılar: AbortController timeout, TEK deneme, retry YOK.
 */

import net from 'node:net';

export interface TcpProbeResult {
  ok: boolean;
  ms: number;
  error?: string;
}

export interface WsdlOperation {
  name: string;
  /** İsim sezgisiyle sınıf: 'write' = create/modify/delete benzeri → Faz 3'e kadar YASAK. */
  kind: 'read' | 'write';
}

export interface WsdlFetchResult {
  ok: boolean;
  httpStatus?: number;
  bytes?: number;
  operations?: WsdlOperation[];
  error?: string;
  ms: number;
}

/** URL'den host+port çıkar (http default 80, https 443). */
export function parseHostPort(wsUrl: string): { host: string; port: number } {
  const u = new URL(wsUrl);
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  return { host: u.hostname, port };
}

/** Saf TCP connect denemesi — HTTP isteği GÖNDERMEZ. */
export function tcpProbe(wsUrl: string, timeoutMs: number): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    let host: string, port: number;
    try {
      ({ host, port } = parseHostPort(wsUrl));
    } catch (err) {
      resolve({ ok: false, ms: 0, error: `URL parse: ${(err as Error).message}` });
      return;
    }
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ ok: false, ms: Date.now() - t0, error: `TCP timeout (${timeoutMs}ms)` });
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve({ ok: true, ms: Date.now() - t0 });
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, ms: Date.now() - t0, error: (err as NodeJS.ErrnoException).code ?? err.message });
    });
  });
}

/**
 * Operasyon adını sınıfla. 'write' = Capture durumunu DEĞİŞTİREBİLECEK isim
 * kalıpları — bu modülde asla çağrılmaz; envanter raporunda kırmızı işaretlenir.
 * Bilinmeyen/şüpheli isimler güvenli taraf için 'write' sayılır (varsayılan tehlikeli).
 */
export function classifyOperation(name: string): 'read' | 'write' {
  const n = name.toLowerCase();
  const READ_HINTS = ['get', 'list', 'query', 'find', 'search', 'read', 'fetch', 'subscribe', 'notification', 'ping', 'version', 'status', 'health'];
  const WRITE_HINTS = ['create', 'add', 'insert', 'delete', 'remove', 'update', 'modify', 'set', 'cancel', 'start', 'stop', 'abort', 'edit', 'write', 'save', 'submit', 'schedule'];
  if (WRITE_HINTS.some((h) => n.includes(h))) return 'write';
  if (READ_HINTS.some((h) => n.startsWith(h) || n.includes(h))) return 'read';
  return 'write'; // bilinmeyen → güvenli taraf: yazma say, dokunma
}

/** WSDL XML'inden <operation name="..."> adlarını çıkar (regex; offline analiz). */
export function extractWsdlOperations(wsdlXml: string): WsdlOperation[] {
  const names = new Set<string>();
  const re = /<(?:[\w-]+:)?operation\b[^>]*\bname\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wsdlXml)) !== null) names.add(m[1]);
  return Array.from(names).sort().map((name) => ({ name, kind: classifyOperation(name) }));
}

/**
 * WSDL'i çek (GET {wsUrl}?wsdl). Salt şema okuması — kayıt verisi sorgulanmaz.
 * Tek deneme; timeout'ta sessizce hata döner (retry YOK — canlı sistemi yormayız).
 */
export async function fetchWsdl(wsUrl: string, timeoutMs: number): Promise<WsdlFetchResult> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const sep = wsUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${wsUrl}${sep}wsdl`, { method: 'GET', signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, bytes: text.length, ms: Date.now() - t0, error: `HTTP ${res.status}` };
    }
    return {
      ok: true,
      httpStatus: res.status,
      bytes: text.length,
      operations: extractWsdlOperations(text),
      ms: Date.now() - t0,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      ms: Date.now() - t0,
      error: isAbort ? `timeout (${timeoutMs}ms)` : ((err as NodeJS.ErrnoException).code ?? (err as Error).message),
    };
  } finally {
    clearTimeout(timer);
  }
}
