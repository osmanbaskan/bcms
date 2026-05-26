import { describe, it, expect } from 'vitest';
import {
  durationFramesInclusive,
  framesToSmpte,
  smpteToFrames,
  provysDurationToFrames,
  compareDurations,
  DEFAULT_TOLERANCE_FRAMES,
} from './ssdb-duration.js';

describe('ssdb-duration > durationFramesInclusive', () => {
  it('canonical: tcSOM=0, tcEOM=4464 -> 4465 (inclusive EOM)', () => {
    expect(durationFramesInclusive(0, 4464)).toBe(4465);
  });

  it('single frame: tcSOM=100, tcEOM=100 -> 1', () => {
    expect(durationFramesInclusive(100, 100)).toBe(1);
  });

  it('SOM offset: tcSOM=250, tcEOM=499 -> 250', () => {
    expect(durationFramesInclusive(250, 499)).toBe(250);
  });

  it('one hour: tcSOM=0, tcEOM=89999 -> 90000', () => {
    expect(durationFramesInclusive(0, 89999)).toBe(90000);
  });

  it('tcSOM > tcEOM -> null', () => {
    expect(durationFramesInclusive(500, 400)).toBeNull();
    expect(durationFramesInclusive(1, 0)).toBeNull();
  });

  it('negative input -> null', () => {
    expect(durationFramesInclusive(-1, 100)).toBeNull();
    expect(durationFramesInclusive(0, -1)).toBeNull();
  });

  it('NaN / Infinity -> null', () => {
    expect(durationFramesInclusive(Number.NaN, 100)).toBeNull();
    expect(durationFramesInclusive(0, Number.NaN)).toBeNull();
    expect(durationFramesInclusive(Number.POSITIVE_INFINITY, 100)).toBeNull();
    expect(durationFramesInclusive(0, Number.POSITIVE_INFINITY)).toBeNull();
    expect(durationFramesInclusive(0, Number.NEGATIVE_INFINITY)).toBeNull();
  });

  it('null / undefined -> null', () => {
    expect(durationFramesInclusive(null, 100)).toBeNull();
    expect(durationFramesInclusive(0, null)).toBeNull();
    expect(durationFramesInclusive(undefined, 100)).toBeNull();
    expect(durationFramesInclusive(0, undefined)).toBeNull();
  });

  it('non-integer (float) input -> null', () => {
    expect(durationFramesInclusive(0.5, 100)).toBeNull();
    expect(durationFramesInclusive(0, 100.7)).toBeNull();
  });
});

describe('ssdb-duration > framesToSmpte', () => {
  it('canonical: 4465 @25fps -> "00:02:58:15"', () => {
    expect(framesToSmpte(4465, 25)).toBe('00:02:58:15');
  });

  it('SOM offset render: 250 @25fps -> "00:00:10:00"', () => {
    expect(framesToSmpte(250, 25)).toBe('00:00:10:00');
  });

  it('one hour exact: 90000 @25fps -> "01:00:00:00"', () => {
    expect(framesToSmpte(90000, 25)).toBe('01:00:00:00');
  });

  it('single frame: 1 @25fps -> "00:00:00:01"', () => {
    expect(framesToSmpte(1, 25)).toBe('00:00:00:01');
  });

  it('zero frames: 0 @25fps -> "00:00:00:00"', () => {
    expect(framesToSmpte(0, 25)).toBe('00:00:00:00');
  });

  it('fps 0 / null / negative -> null', () => {
    expect(framesToSmpte(100, 0)).toBeNull();
    expect(framesToSmpte(100, null)).toBeNull();
    expect(framesToSmpte(100, -25)).toBeNull();
    expect(framesToSmpte(100, undefined)).toBeNull();
  });

  it('NaN / Infinity inputs -> null', () => {
    expect(framesToSmpte(Number.NaN, 25)).toBeNull();
    expect(framesToSmpte(Number.POSITIVE_INFINITY, 25)).toBeNull();
    expect(framesToSmpte(100, Number.NaN)).toBeNull();
    expect(framesToSmpte(100, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('non-integer fps -> null (V1 NDF only)', () => {
    expect(framesToSmpte(100, 29.97)).toBeNull();
  });

  it('negative frames -> null', () => {
    expect(framesToSmpte(-1, 25)).toBeNull();
  });
});

describe('ssdb-duration > smpteToFrames', () => {
  it('canonical: "00:02:58:15" @25 -> 4465', () => {
    expect(smpteToFrames('00:02:58:15', 25)).toBe(4465);
  });

  it('zero: "00:00:00:00" @25 -> 0', () => {
    expect(smpteToFrames('00:00:00:00', 25)).toBe(0);
  });

  it('one hour: "01:00:00:00" @25 -> 90000', () => {
    expect(smpteToFrames('01:00:00:00', 25)).toBe(90000);
  });

  it('roundtrip with framesToSmpte (multiple values)', () => {
    for (const frames of [0, 1, 25, 4465, 90000, 12345]) {
      const tc = framesToSmpte(frames, 25);
      expect(tc).not.toBeNull();
      expect(smpteToFrames(tc as string, 25)).toBe(frames);
    }
  });

  it('invalid format -> null', () => {
    expect(smpteToFrames('abc', 25)).toBeNull();
    expect(smpteToFrames('00:02:58', 25)).toBeNull();
    expect(smpteToFrames('', 25)).toBeNull();
    expect(smpteToFrames('00-02-58-15', 25)).toBeNull();
  });

  it('null / undefined timecode -> null', () => {
    expect(smpteToFrames(null, 25)).toBeNull();
    expect(smpteToFrames(undefined, 25)).toBeNull();
  });

  it('fps 0 / null / negative -> null', () => {
    expect(smpteToFrames('00:02:58:15', 0)).toBeNull();
    expect(smpteToFrames('00:02:58:15', null)).toBeNull();
    expect(smpteToFrames('00:02:58:15', -25)).toBeNull();
  });
});

describe('ssdb-duration > provysDurationToFrames', () => {
  it('prefers durationTimecode: "00:02:58:15" @25 -> 4465', () => {
    const r = provysDurationToFrames({
      durationTimecode: '00:02:58:15',
      durationMs: null,
      frameRate: 25,
    });
    expect(r).toBe(4465);
  });

  it('falls back to durationMs when timecode null', () => {
    // 178560 ms @ 25fps -> round(178.56 * 25) = round(4464) = 4464
    const r = provysDurationToFrames({
      durationTimecode: null,
      durationMs: 178560,
      frameRate: 25,
    });
    expect(r).toBe(4464);
  });

  it('falls back to durationMs when timecode is malformed', () => {
    const r = provysDurationToFrames({
      durationTimecode: 'not-a-tc',
      durationMs: 1000,
      frameRate: 25,
    });
    expect(r).toBe(25);
  });

  it('uses default fps=25 when frameRate null', () => {
    // 1000 ms @25 -> 25 frame
    const r = provysDurationToFrames({
      durationTimecode: null,
      durationMs: 1000,
      frameRate: null,
    });
    expect(r).toBe(25);
  });

  it('uses default fps=25 when frameRate invalid (non-integer)', () => {
    const r = provysDurationToFrames({
      durationTimecode: '00:00:01:00',
      durationMs: null,
      frameRate: 29.97,
    });
    // 29.97 invalid -> fallback fps=25 -> 25 frame
    expect(r).toBe(25);
  });

  it('returns null when both timecode and ms are null', () => {
    expect(
      provysDurationToFrames({ durationTimecode: null, durationMs: null, frameRate: 25 }),
    ).toBeNull();
  });

  it('returns null when durationMs is negative or NaN', () => {
    expect(
      provysDurationToFrames({ durationTimecode: null, durationMs: -1, frameRate: 25 }),
    ).toBeNull();
    expect(
      provysDurationToFrames({ durationTimecode: null, durationMs: Number.NaN, frameRate: 25 }),
    ).toBeNull();
  });

  it('zero ms -> 0 frame', () => {
    expect(
      provysDurationToFrames({ durationTimecode: null, durationMs: 0, frameRate: 25 }),
    ).toBe(0);
  });
});

describe('ssdb-duration > compareDurations', () => {
  it('exact equal -> "equal"', () => {
    expect(compareDurations(4465, 4465, 1)).toBe('equal');
  });

  it('within tolerance 1 (diff=1) -> "equal"', () => {
    expect(compareDurations(4464, 4465, 1)).toBe('equal');
    expect(compareDurations(4466, 4465, 1)).toBe('equal');
  });

  it('outside tolerance 1 (diff=2) -> "mismatch"', () => {
    expect(compareDurations(4463, 4465, 1)).toBe('mismatch');
    expect(compareDurations(4467, 4465, 1)).toBe('mismatch');
  });

  it('any input null -> "unknown"', () => {
    expect(compareDurations(null, 4465, 1)).toBe('unknown');
    expect(compareDurations(4465, null, 1)).toBe('unknown');
    expect(compareDurations(null, null, 1)).toBe('unknown');
  });

  it('NaN / Infinity -> "unknown"', () => {
    expect(compareDurations(Number.NaN, 4465, 1)).toBe('unknown');
    expect(compareDurations(4465, Number.POSITIVE_INFINITY, 1)).toBe('unknown');
  });

  it('default tolerance = 1 frame (V1 lock)', () => {
    expect(DEFAULT_TOLERANCE_FRAMES).toBe(1);
    expect(compareDurations(4464, 4465)).toBe('equal');
    expect(compareDurations(4463, 4465)).toBe('mismatch');
  });

  it('zero tolerance (strict) — diff=1 -> "mismatch"', () => {
    expect(compareDurations(4464, 4465, 0)).toBe('mismatch');
    expect(compareDurations(4465, 4465, 0)).toBe('equal');
  });
});
