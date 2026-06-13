import { describe, expect, it } from 'vitest';
import { Rng } from '../core/rng';
import { HarmonyChain } from './harmony';
import { SCALES } from './scales';

describe('HarmonyChain', () => {
  it('every transition row sums to one, for every scale and origin', () => {
    for (let s = 0; s < SCALES.length; s++) {
      const chain = new HarmonyChain(s, new Rng(1));
      const scale = SCALES[s];
      if (!scale) continue;
      for (const h of scale.harmony) {
        const row = chain.row(h.degree);
        expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
        for (const p of row) expect(p).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is deterministic under a fixed seed', () => {
    const a = new HarmonyChain(0, new Rng(7));
    const b = new HarmonyChain(0, new Rng(7));
    const seqA = Array.from({ length: 50 }, () => a.step());
    const seqB = Array.from({ length: 50 }, () => b.step());
    expect(seqA).toEqual(seqB);
  });

  it('gravitates home to i', () => {
    for (let s = 0; s < SCALES.length; s++) {
      const chain = new HarmonyChain(s, new Rng(99));
      const counts = new Map<number, number>();
      for (let i = 0; i < 2000; i++) {
        const d = chain.step();
        counts.set(d, (counts.get(d) ?? 0) + 1);
      }
      const most = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      expect(most?.[0]).toBe(0);
    }
  });

  it('only ever lands on degrees the scale tables', () => {
    for (let s = 0; s < SCALES.length; s++) {
      const chain = new HarmonyChain(s, new Rng(3));
      const allowed = new Set(SCALES[s]?.harmony.map((h) => h.degree));
      for (let i = 0; i < 500; i++) {
        expect(allowed.has(chain.step())).toBe(true);
      }
    }
  });
});
