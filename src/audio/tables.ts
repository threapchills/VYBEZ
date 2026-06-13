import type { Rng } from '../core/rng';

// Session-baked wavetables: at boot the seed bakes a bank of single-cycle
// tables from harmonic recipes (spectral-tilt prior, comb notches, paired
// partials for shimmer), with per-octave mip levels for band-limited
// playback. Timbres are born fresh each session inside a curated taste
// envelope; the recipe is the envelope, the seed is the individual.

export const TABLE_SIZE = 2048;
export const TABLE_COUNT = 8;
/** Partial caps per mip level; the worklet picks by playback frequency. */
export const MIP_CAPS = [64, 20, 7, 3] as const;

export interface BakedTables {
  /** Layout: [table][mip][TABLE_SIZE], flattened. */
  data: Float32Array;
  tableCount: number;
  mipCount: number;
  size: number;
}

export function bakeWavetables(rng: Rng): BakedTables {
  const mipCount = MIP_CAPS.length;
  const data = new Float32Array(TABLE_COUNT * mipCount * TABLE_SIZE);

  // One phase set for the whole bank, so morphing never phase-cancels.
  const maxPartials = MIP_CAPS[0];
  const phases: number[] = [];
  for (let p = 0; p < maxPartials; p++) phases.push(rng.range(0, Math.PI * 2));

  const tiltStart = rng.range(1.5, 2.1);
  const tiltEnd = rng.range(0.7, 1.1);
  const notchPeriod = rng.int(3, 7);
  const notchDepth = rng.range(0.15, 0.45);
  const shimmer = rng.range(0.1, 0.35);

  for (let t = 0; t < TABLE_COUNT; t++) {
    // The morph axis sweeps dark to bright across the bank.
    const tilt = tiltStart + (tiltEnd - tiltStart) * (t / (TABLE_COUNT - 1));
    const amps: number[] = [];
    for (let p = 1; p <= maxPartials; p++) {
      let amp = 1 / Math.pow(p, tilt);
      if (p % notchPeriod === 0) amp *= notchDepth;
      // Paired-partial shimmer: every even partial leans on its odd neighbour.
      if (p % 2 === 0) amp *= 1 - shimmer + shimmer * Math.sin(t * 1.7 + p);
      amps.push(amp);
    }

    for (let mip = 0; mip < mipCount; mip++) {
      const cap = MIP_CAPS[mip] as number;
      const base = (t * mipCount + mip) * TABLE_SIZE;
      let peak = 0;
      for (let i = 0; i < TABLE_SIZE; i++) {
        let s = 0;
        const phase = (i / TABLE_SIZE) * Math.PI * 2;
        for (let p = 1; p <= cap; p++) {
          s += (amps[p - 1] as number) * Math.sin(phase * p + (phases[p - 1] as number));
        }
        data[base + i] = s;
        peak = Math.max(peak, Math.abs(s));
      }
      if (peak > 0) {
        for (let i = 0; i < TABLE_SIZE; i++) data[base + i] = (data[base + i] as number) / peak;
      }
    }
  }

  return { data, tableCount: TABLE_COUNT, mipCount, size: TABLE_SIZE };
}
