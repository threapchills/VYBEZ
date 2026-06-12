// The seven scales, bottom of the totem to the top, exactly as the handoff
// tables them. Semitone sets from the root; harmony roots with Markov weights.

export interface HarmonyRoot {
  /** Semitones above the scale root. */
  degree: number;
  weight: number;
}

export interface Scale {
  name: string;
  /** Semitone set from the root. */
  set: readonly number[];
  /** Weighted harmony roots; weights sum to 1. */
  harmony: readonly HarmonyRoot[];
  /** Open voicings only: fifths, octaves, quartal stacks; melody carries colour. */
  openVoicings: boolean;
}

export const SCALES: readonly Scale[] = [
  {
    name: 'aeolian',
    set: [0, 2, 3, 5, 7, 8, 10],
    harmony: [
      { degree: 0, weight: 0.3 },
      { degree: 8, weight: 0.2 },
      { degree: 10, weight: 0.2 },
      { degree: 5, weight: 0.15 },
      { degree: 7, weight: 0.15 },
    ],
    openVoicings: false,
  },
  {
    name: 'harmonic minor',
    set: [0, 2, 3, 5, 7, 8, 11],
    harmony: [
      { degree: 0, weight: 0.3 },
      { degree: 7, weight: 0.25 },
      { degree: 8, weight: 0.2 },
      { degree: 5, weight: 0.15 },
      { degree: 3, weight: 0.1 },
    ],
    openVoicings: false,
  },
  {
    name: 'hungarian minor',
    set: [0, 2, 3, 6, 7, 8, 11],
    harmony: [
      { degree: 0, weight: 0.4 },
      { degree: 8, weight: 0.25 },
      { degree: 7, weight: 0.25 },
      { degree: 5, weight: 0.1 },
    ],
    openVoicings: true,
  },
  {
    name: 'double harmonic',
    set: [0, 1, 4, 5, 7, 8, 11],
    harmony: [
      { degree: 0, weight: 0.4 },
      { degree: 1, weight: 0.3 },
      { degree: 7, weight: 0.3 },
    ],
    openVoicings: true,
  },
  {
    name: 'blues minor pentatonic',
    // The b5 (6) is admitted as a weak-beat passing tone only, not a scale member.
    set: [0, 3, 5, 7, 10],
    harmony: [
      { degree: 0, weight: 0.5 },
      { degree: 10, weight: 0.25 },
      { degree: 5, weight: 0.25 },
    ],
    openVoicings: true,
  },
  {
    name: 'major pentatonic',
    set: [0, 2, 4, 7, 9],
    harmony: [
      { degree: 0, weight: 0.5 },
      { degree: 7, weight: 0.25 },
      { degree: 9, weight: 0.25 },
    ],
    openVoicings: true,
  },
  {
    name: 'ionian',
    set: [0, 2, 4, 5, 7, 9, 11],
    harmony: [
      { degree: 0, weight: 0.25 },
      { degree: 9, weight: 0.2 },
      { degree: 5, weight: 0.2 },
      { degree: 7, weight: 0.2 },
      { degree: 2, weight: 0.15 },
    ],
    openVoicings: false,
  },
] as const;

/**
 * Chord tones for a harmony root within a scale, as pitch classes 0 to 11.
 * Open-voicing scales get fifths and octaves; the rest get a diatonic triad.
 */
export function chordTones(scaleIndex: number, rootPc: number, degree: number): number[] {
  const scale = SCALES[scaleIndex];
  if (!scale) throw new Error(`no scale at index ${scaleIndex}`);
  const chordRoot = (rootPc + degree) % 12;
  if (scale.openVoicings) {
    return [chordRoot, (chordRoot + 7) % 12];
  }
  // Diatonic triad: stack two scale thirds above the chord root.
  const set = scale.set.map((s) => (rootPc + s) % 12);
  const idx = set.indexOf(chordRoot);
  if (idx === -1) return [chordRoot, (chordRoot + 7) % 12];
  const third = set[(idx + 2) % set.length] as number;
  const fifth = set[(idx + 4) % set.length] as number;
  return [chordRoot, third, fifth];
}

/** The active scale's pitch classes for a given root. */
export function scaleTones(scaleIndex: number, rootPc: number): number[] {
  const scale = SCALES[scaleIndex];
  if (!scale) throw new Error(`no scale at index ${scaleIndex}`);
  return scale.set.map((s) => (rootPc + s) % 12);
}
