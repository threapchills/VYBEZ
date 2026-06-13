import type { Rng } from '../core/rng';
import { SCALES } from './scales';

// A first-order Markov chain over each scale's harmony roots, biased toward
// return-to-i. The conductor steps it every 2 or 4 bars, seeded per section.

const RETURN_BIAS = 1.4;

export class HarmonyChain {
  private currentDegree = 0;
  private readonly degrees: number[];
  private readonly weights: number[];

  constructor(
    scaleIndex: number,
    private readonly rng: Rng,
  ) {
    const scale = SCALES[scaleIndex];
    if (!scale) throw new Error(`no scale at index ${scaleIndex}`);
    this.degrees = scale.harmony.map((h) => h.degree);
    this.weights = scale.harmony.map((h) => h.weight);
  }

  get degree(): number {
    return this.currentDegree;
  }

  /** One transition row, normalised; exposed so tests can prove rows sum to 1. */
  row(fromDegree: number): number[] {
    const raw = this.degrees.map((d, i) => {
      let w = this.weights[i] as number;
      if (d === 0) w *= RETURN_BIAS;
      // A gentle nudge away from sitting on the same chord forever.
      if (d === fromDegree && d !== 0) w *= 0.6;
      return w;
    });
    const sum = raw.reduce((a, b) => a + b, 0);
    return raw.map((w) => w / sum);
  }

  /** Advance to the next harmony root and return its degree. */
  step(): number {
    const probs = this.row(this.currentDegree);
    let r = this.rng.next();
    for (let i = 0; i < probs.length; i++) {
      r -= probs[i] as number;
      if (r <= 0) {
        this.currentDegree = this.degrees[i] as number;
        return this.currentDegree;
      }
    }
    this.currentDegree = this.degrees[this.degrees.length - 1] as number;
    return this.currentDegree;
  }
}
