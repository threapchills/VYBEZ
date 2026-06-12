import { describe, expect, it } from 'vitest';
import { Rng, sessionSeed } from './rng';

describe('Rng', () => {
  it('is deterministic under a fixed seed', () => {
    const a = new Rng(12345);
    const b = new Rng(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('produces different streams from different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    const same = Array.from({ length: 100 }, () => a.next() === b.next());
    expect(same.every(Boolean)).toBe(false);
  });

  it('stays in [0, 1)', () => {
    const rng = new Rng(999);
    for (let i = 0; i < 10000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('int covers the inclusive range', () => {
    const rng = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(rng.int(0, 3));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });

  it('forks are deterministic and decorrelated', () => {
    const a = new Rng(42).fork('patterns');
    const b = new Rng(42).fork('patterns');
    const c = new Rng(42).fork('palette');
    expect(a.next()).toBe(b.next());
    const aSeq = Array.from({ length: 50 }, () => a.next());
    const cSeq = Array.from({ length: 50 }, () => c.next());
    expect(aSeq).not.toEqual(cSeq);
  });

  it('shuffle preserves the elements', () => {
    const rng = new Rng(3);
    const out = rng.shuffle([1, 2, 3, 4, 5]);
    expect(out.slice().sort()).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('sessionSeed', () => {
  it('honours a dev ?seed= param', () => {
    expect(sessionSeed('?seed=42')).toBe(42);
    expect(sessionSeed('?seed=0')).toBe(0);
  });

  it('falls back to crypto for a malformed param', () => {
    const v = sessionSeed('?seed=banana');
    expect(Number.isFinite(v)).toBe(true);
  });
});
