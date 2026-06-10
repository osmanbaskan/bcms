/**
 * Avid MediaCentral Capture Web Service — config (Faz 0, SALT-OKUMA).
 *
 * 2026-06-10 KESİN KURALLAR (Osman):
 *  - Capture ANA uygulamadır; BCMS onu bozacak hiçbir şey yapamaz.
 *  - Bu modülde YAZMA KODU YOKTUR (create/modify/delete gövdesi yazılmamıştır).
 *  - Tüm dış çağrılar: kısa timeout, TEK deneme, retry yok.
 *  - connectionEnabled default FALSE → URL'e hiç çıkılmaz.
 *
 * Öncelik: capture_settings DB satırı (id=1) > env > default (avid_settings paterni).
 */

import type { PrismaClient } from '@prisma/client';

export interface CaptureConfig {
  /** Capture Web Service kök URL — ör. http://capture-host:8080/ScheduleClient */
  wsUrl: string | null;
  /** Inbound (salt-okuma) bağlantı anahtarı. false → hiçbir ağ çağrısı yapılmaz. */
  connectionEnabled: boolean;
  /** BCMS→Capture YAZMA anahtarı (Faz 3). Bu fazda kod yok; her zaman bilgi amaçlı. */
  writeEnabled: boolean;
  /** Inbound ayna poll aralığı (Faz 1; bu fazda worker yok). */
  pollSeconds: number;
  /** Dış çağrı timeout (ms). Tek deneme; retry yok. */
  timeoutMs: number;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function parsePositiveInt(v: string | undefined, fallback: number): number {
  if (!v || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/** Env-only taban config (DB satırı yokken/testte). */
export function loadCaptureEnvConfig(env: NodeJS.ProcessEnv = process.env): CaptureConfig {
  return {
    wsUrl:             env.CAPTURE_WS_URL?.trim() || null,
    connectionEnabled: parseBool(env.CAPTURE_WS_ENABLED, false),
    writeEnabled:      false, // env'den YAZMA anahtarı açılamaz — yalnız DB (Admin+Ingest UI)
    pollSeconds:       parsePositiveInt(env.CAPTURE_WS_POLL_SECONDS, 60),
    timeoutMs:         parsePositiveInt(env.CAPTURE_WS_TIMEOUT_MS, 10_000),
  };
}

/** Efektif config: DB satırı env'in üstüne biner (null alan env'e düşer). */
export async function loadCaptureConfig(
  prisma: PrismaClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CaptureConfig> {
  const base = loadCaptureEnvConfig(env);
  try {
    const row = await prisma.captureSetting.findUnique({ where: { id: 1 } });
    if (!row) return base;
    return {
      wsUrl:             row.wsUrl?.trim() || base.wsUrl,
      connectionEnabled: row.connectionEnabled,
      writeEnabled:      row.writeEnabled,
      pollSeconds:       row.pollSeconds > 0 ? row.pollSeconds : base.pollSeconds,
      timeoutMs:         base.timeoutMs,
    };
  } catch {
    // DB okunamazsa env tabanına düş — canlı akış kesilmez, bağlantı default kapalı.
    return base;
  }
}
