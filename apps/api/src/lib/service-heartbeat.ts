/**
 * Background service heartbeat tracker — Y15 (2026-05-29).
 *
 * Worker container'da 13 background service çalışıyor. Mevcut Docker healthcheck
 * DB + RabbitMQ ping'i; deadlock olan service'i fark etmez. Bu modül service
 * başına son tick zamanı tutar; /health/live endpoint per-service threshold
 * ile alive/stale durumu raporlar.
 *
 * Kullanım (her service'in tick fonksiyonu başında):
 *   recordHeartbeat('ssdb-resolver');
 *
 * RabbitMQ consumer (event-driven) servisleri için: boot anında bir kez +
 * her message process'te. Idle period için threshold uzun tutulur.
 */

/** Service başına beklenen tick interval ve "stale" eşiği (3× expected). */
export interface ServiceHealthConfig {
  /** Beklenen tick interval (ms). Idempotent/event-driven için yaklaşık değer. */
  expectedIntervalMs: number;
  /** Stale threshold (ms) — bu süreden uzun heartbeat yoksa "dead". */
  staleThresholdMs: number;
}

/**
 * Service config tablosu. Yeni service eklenirse buraya da kaydedilmeli.
 *
 * Event-driven service'ler (notifications, ingest-worker) RabbitMQ consumer
 * idle iken heartbeat atamaz; threshold daha esnek (10 dk).
 *
 * Günlük job'lar (audit-retention, audit-partition) 24 saatte bir tick atar;
 * threshold 25 saat.
 *
 * Polling service'ler için: 3× expected interval (3 tick miss → dead).
 */
const SERVICE_CONFIGS: Record<string, ServiceHealthConfig> = {
  notifications:    { expectedIntervalMs:  60_000, staleThresholdMs: 10 * 60_000 }, // event-driven RabbitMQ
  'ingest-worker':  { expectedIntervalMs:  60_000, staleThresholdMs: 10 * 60_000 }, // event-driven RabbitMQ
  'ingest-watcher': { expectedIntervalMs:  30_000, staleThresholdMs:  3 * 60_000 },
  'audit-retention':{ expectedIntervalMs: 24 * 3_600_000, staleThresholdMs: 25 * 3_600_000 },
  'audit-partition':{ expectedIntervalMs: 24 * 3_600_000, staleThresholdMs: 25 * 3_600_000 },
  'outbox-poller':  { expectedIntervalMs:   5_000, staleThresholdMs:      60_000 },
  'provys-watcher': { expectedIntervalMs:  30_000, staleThresholdMs:  3 * 60_000 },
  'asrun-watcher':  { expectedIntervalMs:  30_000, staleThresholdMs:  3 * 60_000 },
  'ssdb-resolver':  { expectedIntervalMs:  60_000, staleThresholdMs:  3 * 60_000 },
  'search-worker':  { expectedIntervalMs:   5_000, staleThresholdMs:      60_000 },
  'restore-worker': { expectedIntervalMs:   5_000, staleThresholdMs:      60_000 },
  'transfer-worker':{ expectedIntervalMs:   5_000, staleThresholdMs:      60_000 },
};

/** Module-scope: serviceName -> son tick ms. */
const lastHeartbeats = new Map<string, number>();

/**
 * Service tick attı; heartbeat'i kaydet.
 * Bilinmeyen service name verilirse de Map'e yazılır (defansif); config
 * yoksa stale threshold check'te skip edilir.
 */
export function recordHeartbeat(service: string): void {
  lastHeartbeats.set(service, Date.now());
}

/**
 * Test/debug için: registered service'ler.
 */
export function getRegisteredServices(): string[] {
  return Object.keys(SERVICE_CONFIGS);
}

export interface ServiceHealthStatus {
  service: string;
  ageMs: number | null;
  thresholdMs: number;
  alive: boolean;
  lastTickAt: string | null;
}

/**
 * Sadece kayıtlı (BCMS_BACKGROUND_SERVICES'te enabled) servislerin durumu.
 * `enabledServices` param: bu container'da çalışan servis isimleri.
 * Bilinmeyen servis adları (config'te yok) skip edilir.
 */
export function getServiceHealthStatuses(
  enabledServices: readonly string[],
  now: number = Date.now(),
): ServiceHealthStatus[] {
  const out: ServiceHealthStatus[] = [];
  for (const service of enabledServices) {
    const cfg = SERVICE_CONFIGS[service];
    if (!cfg) continue;
    const lastTick = lastHeartbeats.get(service);
    const ageMs = lastTick !== undefined ? now - lastTick : null;
    const alive = ageMs !== null && ageMs <= cfg.staleThresholdMs;
    out.push({
      service,
      ageMs,
      thresholdMs: cfg.staleThresholdMs,
      alive,
      lastTickAt: lastTick !== undefined ? new Date(lastTick).toISOString() : null,
    });
  }
  return out;
}

/**
 * Prometheus gauge için: per-service age in seconds.
 * Bilinmeyen veya hiç heartbeat atmamış servis için age = -1 (sentinel).
 */
export function getServiceAgeSeconds(service: string): number {
  const lastTick = lastHeartbeats.get(service);
  if (lastTick === undefined) return -1;
  return Math.floor((Date.now() - lastTick) / 1000);
}

/**
 * Event-driven veya polling service'ler için generic heartbeat ticker.
 * - Boot anında ilk heartbeat (cold start sırasında healthcheck fail etmesin).
 * - `intervalMs` aralığıyla periyodik heartbeat (process yaşadığı sürece tick).
 * - Fastify `onClose` hook ile cleanup (graceful shutdown).
 *
 * Idle watcher'lar (provys, asrun, ingest) ve event-driven consumer'lar
 * (notifications, ingest-worker) için kullanılır. Polling worker'lar kendi
 * tick'inde direkt `recordHeartbeat` çağırabilir.
 */
export function startHeartbeatTicker(
  service: string,
  hooks: { addHook(name: 'onClose', fn: () => Promise<void> | void): void },
  intervalMs: number = 60_000,
): void {
  recordHeartbeat(service);
  const timer = setInterval(() => recordHeartbeat(service), intervalMs);
  timer.unref();
  hooks.addHook('onClose', () => {
    clearInterval(timer);
  });
}
