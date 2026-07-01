import type { SpiritId } from './contracts';
import type { Rng } from './rng';
import { BPM_MAX, BPM_MIN, BPM_STEP } from './time';

// Everything the seed decides about a session, derived once and shared by the
// scene, the conductor and the engine, so the moon the player sees is the
// root the valley plays.

export interface Session {
  /** Totem notch 0 to 6, bottom to top. */
  scaleIndex: number;
  /** Moon position 0 to 11 along the sky arc; doubles as the root pitch class. */
  moonPosition: number;
  /** Censer notch, 60 to 92 in steps of 4. */
  bpm: number;
  /** Initial fire intensity, 0.35 to 1. */
  fire: number;
  /** Bars per section, 8 or 16. */
  sectionBars: number;
  /** The seeded sleepers; always leaves at least one of root or breath awake. */
  asleep: ReadonlySet<SpiritId>;
}

export function createSession(rng: Rng): Session {
  const notches = (BPM_MAX - BPM_MIN) / BPM_STEP;
  // All seven wake with the fire: the full ensemble is the experience, and a
  // tap can always send one to sleep. (Overhauled from the seeded 2-4 sleepers,
  // which left first sessions sounding like three instruments.)
  const asleep = new Set<SpiritId>();

  return {
    scaleIndex: rng.int(0, 6),
    moonPosition: rng.int(0, 11),
    bpm: BPM_MIN + rng.int(0, notches) * BPM_STEP,
    fire: rng.range(0.5, 0.9),
    sectionBars: rng.chance(0.5) ? 8 : 16,
    asleep,
  };
}
