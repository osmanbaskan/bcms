import { describe, expect, it, vi } from 'vitest';
import { ResponseCache } from './response-cache.js';

describe('ResponseCache (YP0.2)', () => {
  it('TTL içinde aynı key için tek compute() çağırır (cache hit)', async () => {
    const cache = new ResponseCache<string>({ ttlMs: 5_000 });
    const compute = vi.fn(async () => 'value-1');
    const r1 = await cache.getOrCompute('k', compute);
    const r2 = await cache.getOrCompute('k', compute);
    expect(r1).toBe('value-1');
    expect(r2).toBe('value-1');
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('TTL geçince yeniden compute eder', async () => {
    vi.useFakeTimers();
    try {
      const cache = new ResponseCache<number>({ ttlMs: 1_000 });
      let counter = 0;
      const compute = async () => ++counter;
      const r1 = await cache.getOrCompute('k', compute);
      vi.advanceTimersByTime(1_500);
      const r2 = await cache.getOrCompute('k', compute);
      expect(r1).toBe(1);
      expect(r2).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('paralel istekler in-flight Promise paylaşır (dog-pile prevention)', async () => {
    const cache = new ResponseCache<string>({ ttlMs: 5_000 });
    let resolveCompute: (v: string) => void = () => {};
    const computeStarted = vi.fn();
    const compute = async () => {
      computeStarted();
      return await new Promise<string>((resolve) => { resolveCompute = resolve; });
    };
    // 250 paralel istek
    const promises = Array.from({ length: 250 }, () => cache.getOrCompute('k', compute));
    // Tick: in-flight Promise registered
    await Promise.resolve();
    // Compute sadece 1 kez başlamış
    expect(computeStarted).toHaveBeenCalledTimes(1);
    resolveCompute('shared-value');
    const results = await Promise.all(promises);
    expect(results.every((r) => r === 'shared-value')).toBe(true);
    expect(computeStarted).toHaveBeenCalledTimes(1);
  });

  it('onResult callback hit/miss/inflight raporlar', async () => {
    const onResult = vi.fn();
    const cache = new ResponseCache<string>({ ttlMs: 5_000, onResult });
    const compute = async () => 'v';

    // 1. çağrı = miss
    await cache.getOrCompute('k', compute);
    expect(onResult).toHaveBeenLastCalledWith('miss');

    // 2. çağrı = hit
    await cache.getOrCompute('k', compute);
    expect(onResult).toHaveBeenLastCalledWith('hit');

    // 3. paralel iki çağrı: ilki miss, ikincisi inflight
    let slowResolve: (v: string) => void = () => {};
    const slowCompute = async () => new Promise<string>((r) => { slowResolve = r; });
    onResult.mockClear();
    const p1 = cache.getOrCompute('k2', slowCompute);
    const p2 = cache.getOrCompute('k2', slowCompute);
    await Promise.resolve();
    slowResolve('v2');
    await Promise.all([p1, p2]);
    expect(onResult).toHaveBeenCalledWith('miss');
    expect(onResult).toHaveBeenCalledWith('inflight');
  });

  it('compute() reject ederse in-flight temizlenir + sonraki çağrı yeniden dener', async () => {
    const cache = new ResponseCache<string>({ ttlMs: 5_000 });
    let attempt = 0;
    const compute = async () => {
      attempt++;
      if (attempt === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(cache.getOrCompute('k', compute)).rejects.toThrow('boom');
    const r = await cache.getOrCompute('k', compute);
    expect(r).toBe('ok');
    expect(attempt).toBe(2);
  });

  it('ttlMs=0 cache devre dışı bırakır', async () => {
    const cache = new ResponseCache<number>({ ttlMs: 0 });
    let counter = 0;
    const compute = async () => ++counter;
    await cache.getOrCompute('k', compute);
    await cache.getOrCompute('k', compute);
    expect(counter).toBe(2);
  });

  it('maxEntries aşıldığında LRU eviction yapar', async () => {
    const cache = new ResponseCache<string>({ ttlMs: 60_000, maxEntries: 2 });
    await cache.getOrCompute('a', async () => 'A');
    await cache.getOrCompute('b', async () => 'B');
    expect(cache.size()).toBe(2);
    await cache.getOrCompute('c', async () => 'C');
    expect(cache.size()).toBe(2);
    // a en eski → evict edilmiş; yeni compute miss olur
    const computeA = vi.fn(async () => 'A-NEW');
    await cache.getOrCompute('a', computeA);
    expect(computeA).toHaveBeenCalledTimes(1);
  });

  it('invalidate(key) tek entry temizler', async () => {
    const cache = new ResponseCache<number>({ ttlMs: 60_000 });
    let counter = 0;
    const compute = async () => ++counter;
    await cache.getOrCompute('k', compute);
    cache.invalidate('k');
    const r = await cache.getOrCompute('k', compute);
    expect(r).toBe(2);
  });
});
