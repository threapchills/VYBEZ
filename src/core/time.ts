// Musical time arithmetic. The transport counts 16th-note slots;
// bar = 4 beats = 16 slots. Sections are 8 or 16 bars, chosen per seed.

export const BEATS_PER_BAR = 4;
export const SLOTS_PER_BEAT = 4;
export const SLOTS_PER_BAR = BEATS_PER_BAR * SLOTS_PER_BEAT;

/** Censer range, quantised in 4 BPM notches. */
export const BPM_MIN = 60;
export const BPM_MAX = 92;
export const BPM_STEP = 4;

export function secondsPerBeat(bpm: number): number {
  return 60 / bpm;
}

export function secondsPerSlot(bpm: number): number {
  return secondsPerBeat(bpm) / SLOTS_PER_BEAT;
}

export function barOfSlot(slot: number): number {
  return Math.floor(slot / SLOTS_PER_BAR);
}

export function slotInBar(slot: number): number {
  return ((slot % SLOTS_PER_BAR) + SLOTS_PER_BAR) % SLOTS_PER_BAR;
}

/** Strong beats are 1 and 3 of the bar: slots 0 and 8. */
export function isStrongBeat(slot: number): boolean {
  const s = slotInBar(slot);
  return s === 0 || s === SLOTS_PER_BEAT * 2;
}

/** Snap an arbitrary BPM to the nearest censer notch. */
export function snapBpm(bpm: number): number {
  const clamped = Math.min(BPM_MAX, Math.max(BPM_MIN, bpm));
  return BPM_MIN + Math.round((clamped - BPM_MIN) / BPM_STEP) * BPM_STEP;
}
