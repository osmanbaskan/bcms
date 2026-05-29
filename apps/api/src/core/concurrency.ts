/**
 * Generic bounded concurrency limiter — saf FIFO queue.
 *
 * Origin: 2026-05-09 Provys watcher initial-scan'da 150+ (channel, date)
 * grup aynı anda Prisma'ya basıp connection pool (default 5) tüketince
 * P2024 timeout fırlatıyordu. ConcurrencyLimiter eş zamanlı çalışan job
 * sayısını sabit tutar; geri kalanlar FIFO sırasına alınır.
 *
 * 2026-05-27: SSDB resolver ve worker tarafından da kullanıldığı için
 * Provys feature module'undan core/ altına taşındı. Provys eski path
 * geriye uyumlu re-export ile çalışmaya devam eder.
 *
 * Bu sınıf DB / network / env bağımsız; sadece async kuyruk yönetimi yapar.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isFinite(max) || max < 1) {
      throw new Error(`ConcurrencyLimiter: max must be >= 1 (got ${max})`);
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
