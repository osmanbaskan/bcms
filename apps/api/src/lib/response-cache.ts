/**
 * In-memory response cache — YP0.2 (2026-05-29, 250 user scale).
 *
 * 250 paralel kullanıcı + 5 sn polling = aynı endpoint'e 50 req/sn. Her istek
 * arkasındaki 12 DB query (6 kanal × 2 sorgu) backend'i saturate eder.
 *
 * Bu helper iki katmanlı koruma sağlar:
 *   1. TTL cache — fresh response key bazında saklanır; TTL süresince istek
 *      DB'ye dokunmadan döner.
 *   2. In-flight dedup — TTL miss anında aynı key için paralel istekler tek
 *      compute() Promise'ini paylaşır (dog-pile prevention). 250 paralel
 *      cache miss = 1 backend hit.
 *
 * Tasarım kararları:
 * - TTL kısa tutulur (default 5 sn) — kullanıcı görüş açısı: polling süresiyle
 *   eşleşir; UI tarafında fark edilmez.
 * - Memory bound: setInterval temizliği yok; TTL geçmiş entry next get() içinde
 *   lazy temizlenir. Key cardinality düşük olmalı (örn. tarih bazlı, 7-14 key).
 *   Kontrolsüz key cardinality için `maxEntries` cap zorlanır.
 * - Tip-güvenli: cache'in döndüğü tip compute() return type'ından çıkarılır.
 * - Bypass yok — TTL=0 set edilirse cache devre dışı (test/debug için).
 *
 * Kullanım:
 *   const cache = new ResponseCache<RestoreMissingResponse>({ ttlMs: 5000 });
 *   const result = await cache.getOrCompute(key, () => computeExpensive());
 */

export interface ResponseCacheOptions {
  /** TTL in ms; entry bu süre içinde fresh sayılır. 0 = devre dışı. */
  ttlMs: number;
  /** Maks. eşzamanlı entry sayısı (memory cap); aşıldığında LRU eviction. Default 64. */
  maxEntries?: number;
  /** Cache hit/miss/inflight gözlemi — Prometheus counter wiring için. */
  onResult?: (result: 'hit' | 'miss' | 'inflight') => void;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  /** LRU eviction için son okuma timestamp. */
  lastAccessAt: number;
}

export class ResponseCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly onResult?: (r: 'hit' | 'miss' | 'inflight') => void;

  constructor(opts: ResponseCacheOptions) {
    this.ttlMs = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 64;
    this.onResult = opts.onResult;
  }

  async getOrCompute(key: string, compute: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return compute();

    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) {
      entry.lastAccessAt = now;
      this.onResult?.('hit');
      return entry.value;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.onResult?.('inflight');
      return pending;
    }

    this.onResult?.('miss');
    const promise = (async () => {
      try {
        const value = await compute();
        this.entries.set(key, {
          value,
          expiresAt: Date.now() + this.ttlMs,
          lastAccessAt: Date.now(),
        });
        this.evictIfNeeded();
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  /** Test/debug için manuel invalidation. */
  invalidate(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(key);
  }

  /** Gözlemlenebilir state — test/metrics için. */
  size(): number { return this.entries.size; }

  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;
    // LRU: en eski lastAccessAt'i sil.
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [k, e] of this.entries) {
      if (e.lastAccessAt < oldestAt) {
        oldestAt = e.lastAccessAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) this.entries.delete(oldestKey);
  }
}
