/**
 * Saf concurrency-limited promise queue. Watcher initial scan'inde
 * 150+ (channel, date) group'unun aynı anda Prisma'ya basması connection
 * pool'unu (default 5) tüketip P2024 timeout fırlatıyor. Bu limiter
 * eş zamanlı çalışan job sayısını sabit tutar; geri kalanlar sıraya
 * alınır. FIFO; reject olmaz.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`ConcurrencyLimiter: max must be ≥ 1 (got ${max})`);
    }
  }

  /** Görev sayısı kapasiteyi geçerse sıraya alır; sonra çalıştırır. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /** Şu an çalışan görev sayısı (test/log için). */
  get inFlight(): number { return this.active; }
  /** Beklemedeki görev sayısı. */
  get pending(): number { return this.queue.length; }
}
