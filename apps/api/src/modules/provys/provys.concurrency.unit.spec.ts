import { describe, it, expect } from 'vitest';
import { ConcurrencyLimiter } from './provys.concurrency.js';

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('ConcurrencyLimiter', () => {
  it('throws on invalid max', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
    expect(() => new ConcurrencyLimiter(-1)).toThrow();
    expect(() => new ConcurrencyLimiter(NaN)).toThrow();
  });

  it('runs tasks under the limit immediately', async () => {
    const limiter = new ConcurrencyLimiter(3);
    const result = await limiter.run(async () => 42);
    expect(result).toBe(42);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it('limits in-flight count to max; queues the rest FIFO', async () => {
    const limiter = new ConcurrencyLimiter(2);
    const gates = [defer(), defer(), defer(), defer()];
    const order: number[] = [];

    const promises = gates.map((g, i) =>
      limiter.run(async () => {
        order.push(i);
        await g.promise;
        return i;
      }),
    );

    // İlk iki paralel başladı (in-flight 2), kalan 2 sırada.
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([0, 1]);
    expect(limiter.inFlight).toBe(2);
    expect(limiter.pending).toBe(2);

    // 0 bitince 2 başlar.
    gates[0].resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([0, 1, 2]);
    expect(limiter.inFlight).toBe(2);
    expect(limiter.pending).toBe(1);

    // 1 bitince 3 başlar.
    gates[1].resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual([0, 1, 2, 3]);
    expect(limiter.pending).toBe(0);

    gates[2].resolve();
    gates[3].resolve();
    const results = await Promise.all(promises);
    expect(results).toEqual([0, 1, 2, 3]);
    expect(limiter.inFlight).toBe(0);
  });

  it('releases slot even when task rejects', async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(limiter.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(limiter.inFlight).toBe(0);
    // Bir sonraki çağrı problemsiz çalışmalı.
    const value = await limiter.run(async () => 'ok');
    expect(value).toBe('ok');
  });

  it('serializes when max=1', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];
    const tasks = [0, 1, 2].map((i) =>
      limiter.run(async () => {
        order.push(i);
        await new Promise((r) => setTimeout(r, 5));
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2]);
  });
});
