import { describe, it, expect } from 'vitest';
import { parseBoolEnv, parsePollIntervalMs } from './provys.watcher.js';

describe('provys.watcher › parseBoolEnv', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['TRUE', true],
    ['yes', true],
    ['on', true],
    [' true ', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['random', false],
    ['', false], // boş string → fallback (default false)
  ])('parses %p → %p', (raw, expected) => {
    expect(parseBoolEnv(raw)).toBe(expected);
  });

  it('undefined → fallback', () => {
    expect(parseBoolEnv(undefined)).toBe(false);
    expect(parseBoolEnv(undefined, true)).toBe(true);
  });
});

describe('provys.watcher › parsePollIntervalMs', () => {
  it('parses valid positive number', () => {
    expect(parsePollIntervalMs('30000')).toBe(30_000);
    expect(parsePollIntervalMs('15000')).toBe(15_000);
  });

  it('falls back when undefined / empty / non-numeric / non-positive', () => {
    expect(parsePollIntervalMs(undefined)).toBe(30_000);
    expect(parsePollIntervalMs('')).toBe(30_000);
    expect(parsePollIntervalMs('   ')).toBe(30_000);
    expect(parsePollIntervalMs('abc')).toBe(30_000);
    expect(parsePollIntervalMs('0')).toBe(30_000);
    expect(parsePollIntervalMs('-500')).toBe(30_000);
    expect(parsePollIntervalMs(undefined, 60_000)).toBe(60_000);
  });

  it('clamps below 1000 ms to 1000 ms (IO bombardımanı koruma)', () => {
    expect(parsePollIntervalMs('100')).toBe(1000);
    expect(parsePollIntervalMs('999')).toBe(1000);
    expect(parsePollIntervalMs('1000')).toBe(1000);
  });

  it('truncates fractional values', () => {
    expect(parsePollIntervalMs('1500.7')).toBe(1500);
  });
});
