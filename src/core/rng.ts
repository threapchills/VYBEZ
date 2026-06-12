// One seeded RNG is the source of all variation in a session.
// mulberry32 for streams, splitmix32-style hashing to derive child seeds,
// so each subsystem gets an independent deterministic stream from one root seed.

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next float in [0, 1). mulberry32. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined && items.length === 0) {
      throw new Error('cannot pick from an empty list');
    }
    return item as T;
  }

  /** Fisher-Yates, returns a new array. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const a = out[i] as T;
      out[i] = out[j] as T;
      out[j] = a;
    }
    return out;
  }

  /**
   * Derive an independent child stream, e.g. rng.fork('patterns').
   * The label is hashed with the parent's current state so forks are
   * deterministic but decorrelated.
   */
  fork(label: string): Rng {
    let h = this.state;
    for (let i = 0; i < label.length; i++) {
      h = Math.imul(h ^ label.charCodeAt(i), 0x9e3779b1);
      h = (h << 13) | (h >>> 19);
    }
    // splitmix32-style finaliser
    h = (h + 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
    h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
    h = (h ^ (h >>> 15)) >>> 0;
    return new Rng(h);
  }
}

/**
 * The session seed: crypto randomness, unless a dev-only ?seed= query param
 * overrides it for reproducible QA. Never surfaced in the UI.
 */
export function sessionSeed(search: string = window.location.search): number {
  const param = new URLSearchParams(search).get('seed');
  if (param !== null) {
    const parsed = Number.parseInt(param, 10);
    if (Number.isFinite(parsed)) return parsed >>> 0;
  }
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] as number;
}
