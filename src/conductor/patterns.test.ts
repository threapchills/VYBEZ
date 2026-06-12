import { describe, expect, it } from 'vitest';
import { euclid, rotate } from './patterns';

const toStr = (p: boolean[]): string => p.map((x) => (x ? 'x' : '.')).join('');

describe('euclid', () => {
  it('spreads onsets evenly', () => {
    expect(toStr(euclid(4, 16))).toBe('...x...x...x...x');
    expect(toStr(euclid(3, 8))).toBe('..x..x.x');
    expect(toStr(euclid(5, 16)).split('x').length - 1).toBe(5);
    expect(toStr(euclid(7, 16)).split('x').length - 1).toBe(7);
  });

  it('handles the degenerate cases', () => {
    expect(euclid(0, 4)).toEqual([false, false, false, false]);
    expect(euclid(4, 4)).toEqual([true, true, true, true]);
    expect(euclid(9, 4)).toEqual([true, true, true, true]);
    expect(euclid(3, 0)).toEqual([]);
  });

  it('never lets gap sizes differ by more than one', () => {
    for (const [k, n] of [
      [5, 16],
      [7, 16],
      [9, 16],
      [13, 16],
      [3, 8],
    ] as const) {
      const p = euclid(k, n);
      const onsets = p.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
      const gaps = onsets.map((v, i) => {
        const next = onsets[(i + 1) % onsets.length] as number;
        return (next - v + n) % n || n;
      });
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
    }
  });
});

describe('rotate', () => {
  it('rotates and wraps in both directions', () => {
    expect(rotate([1, 2, 3, 4], 1)).toEqual([2, 3, 4, 1]);
    expect(rotate([1, 2, 3, 4], -1)).toEqual([4, 1, 2, 3]);
    expect(rotate([1, 2, 3, 4], 5)).toEqual([2, 3, 4, 1]);
    expect(rotate([], 3)).toEqual([]);
  });
});
