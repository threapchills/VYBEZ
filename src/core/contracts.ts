// The contracts: every module codes to these and nothing else.
// Modules communicate only through the bus (src/core/bus.ts) using these shapes.

export type SpiritId =
  | 'drum'
  | 'rattle'
  | 'root'
  | 'voice'
  | 'echo'
  | 'spinner'
  | 'breath'
  | 'world';

export const SPIRIT_IDS: readonly SpiritId[] = [
  'drum',
  'rattle',
  'root',
  'voice',
  'echo',
  'spinner',
  'breath',
  'world',
] as const;

/** The seven playable spirits; the world is the hidden eighth voice and has no body on screen. */
export const PLAYABLE_SPIRITS: readonly SpiritId[] = SPIRIT_IDS.filter((id) => id !== 'world');

/** A single scheduled note, sample-stamped by the conductor, rendered by the audio engine. */
export interface NoteEvent {
  spirit: SpiritId;
  /** AudioContext time in seconds at which the note starts. */
  time: number;
  /** MIDI note number; absent for unpitched events such as noise bursts. */
  midi?: number;
  /** 0 to 1. */
  velocity: number;
  /** Seconds. */
  duration: number;
  /** Patch-defined articulation hint, e.g. 'ghost', 'accent', 'riser'. */
  articulation?: string;
  /**
   * Per-note timbre position, 0 to 1 with 0.5 neutral. The conductor breathes
   * this with slow seeded drift so no two notes render identically; the worklet
   * reads it as a deviation around the patch (whose centre the talisman moves).
   */
  timbre?: number;
}

/**
 * A control change from the interaction layer.
 * Targets: 'totem', 'moon', 'censer', 'fire', 'wind', 'strum',
 * 'busy:<id>', 'timbre:<id>', 'space:<id>', 'wake:<id>'.
 */
export interface ControlEvent {
  target: string;
  value: number;
  /**
   * Optional second axis, normalised 0 to 1. The sky harp ('strum') uses it:
   * value carries the position along the arc (pitch), y the height of the
   * touch (velocity for the conductor, glint placement for the scene).
   */
  y?: number;
}

/** Broadcast by the conductor at every bar; the harmonic weather every voice draws from. */
export interface SectionEvent {
  bar: number;
  /** Semitones from the root, 0 to 11. */
  chordRoot: number;
  /** MIDI pitch classes of the sounding chord. */
  chordTones: number[];
  /** MIDI pitch classes of the active scale. */
  scaleTones: number[];
  /** True when this bar begins a new section. */
  turn: boolean;
}

/** The playable state of one voice, as the audio engine sees it. */
export interface VoiceParams {
  morph: number;
  damp: number;
  bright: number;
  busy: number;
}

/** Palette update: which scale ramp is active and how far a section-turn ease has travelled. */
export interface PaletteEvent {
  /** Index into the seven scale ramps, 0 to 6. */
  scaleIndex: number;
  /** Moon position 0 to 11; rotates accent hues within +-25 degrees. */
  moonPosition: number;
  /** Fire intensity 0.35 to 1; warms the midtones. */
  fire: number;
}

/** Wake or sleep transition for one spirit; the crossfade lasts two bars. */
export interface WakeEvent {
  spirit: SpiritId;
  awake: boolean;
}

/** The five bus topics and their payloads. */
export interface BusTopics {
  note: NoteEvent;
  control: ControlEvent;
  section: SectionEvent;
  palette: PaletteEvent;
  wake: WakeEvent;
}
