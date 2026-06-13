import type { ControlEvent, SpiritId } from '../core/contracts';
import { snapBpm } from '../core/time';

// Pure control mapping: raw input to ControlEvent values, one helper per object
// in the scene's control table. No Pixi, no audio, no bus; the pointer layer
// owns geometry and publishing, this owns the arithmetic. Keeping it pure means
// the whole control surface is unit-testable without a browser.

export const SCALE_NOTCHES = 7;
export const MOON_POSITIONS = 12;

export const FIRE_FLOOR = 0.35;
export const FIRE_CEIL = 1.0;
/** A single stoke tap nudges the fire this far toward 1.0. */
export const FIRE_STOKE_STEP = 0.2;
/**
 * The fire cools toward its floor. Time constant chosen so a full blaze settles
 * most of the way back to the floor over roughly three minutes, per the brief.
 */
export const FIRE_DECAY_TAU_S = 80;

export type WindState = 'still' | 'breeze' | 'gale';
const WIND_CYCLE: readonly WindState[] = ['still', 'breeze', 'gale'];

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Totem: tap clicks the glowing segment upward, wrapping at the top. */
export function nextScaleNotch(current: number): number {
  return (((current + 1) % SCALE_NOTCHES) + SCALE_NOTCHES) % SCALE_NOTCHES;
}

/** Moon: a normalised position along the sky arc snaps to one of twelve. */
export function snapMoonPosition(arcT: number): number {
  const t = clamp01(arcT);
  return Math.round(t * (MOON_POSITIONS - 1));
}

/** Censer: a pushed BPM settles to the nearest 4 BPM notch. */
export function snapCenser(bpm: number): number {
  return snapBpm(bpm);
}

/** Fire: a stoke tap, clamped to the ceiling. */
export function stokeFire(current: number, step: number = FIRE_STOKE_STEP): number {
  return Math.min(FIRE_CEIL, current + step);
}

/** Fire: exponential cooling toward the floor over a time step in seconds. */
export function decayFire(current: number, dtSeconds: number): number {
  const decayed = FIRE_FLOOR + (current - FIRE_FLOOR) * Math.exp(-dtSeconds / FIRE_DECAY_TAU_S);
  return Math.max(FIRE_FLOOR, Math.min(FIRE_CEIL, decayed));
}

/** Wind: tap cycles still to breeze to gale and back. */
export function nextWind(current: WindState): WindState {
  const i = WIND_CYCLE.indexOf(current);
  return WIND_CYCLE[(i + 1) % WIND_CYCLE.length] as WindState;
}

/** The bus carries numbers; wind states ride as 0, 1, 2. */
export function windToValue(state: WindState): number {
  return WIND_CYCLE.indexOf(state);
}

export function windFromValue(value: number): WindState {
  const i = Math.round(value);
  return WIND_CYCLE[Math.max(0, Math.min(WIND_CYCLE.length - 1, i))] as WindState;
}

// ControlEvent builders. Targets follow the contracts comment exactly:
// totem, moon, censer, fire, wind, busy:<id>, timbre:<id>, wake:<id>.

export function totemEvent(notch: number): ControlEvent {
  return { target: 'totem', value: notch };
}

export function moonEvent(position: number): ControlEvent {
  return { target: 'moon', value: position };
}

export function censerEvent(bpm: number): ControlEvent {
  return { target: 'censer', value: snapCenser(bpm) };
}

export function fireEvent(intensity: number): ControlEvent {
  return { target: 'fire', value: Math.max(FIRE_FLOOR, Math.min(FIRE_CEIL, intensity)) };
}

export function windEvent(state: WindState): ControlEvent {
  return { target: 'wind', value: windToValue(state) };
}

export function wakeEvent(spirit: SpiritId, awake: boolean): ControlEvent {
  return { target: `wake:${spirit}`, value: awake ? 1 : 0 };
}

export function busyEvent(spirit: SpiritId, value: number): ControlEvent {
  return { target: `busy:${spirit}`, value: clamp01(value) };
}

export function timbreEvent(spirit: SpiritId, value: number): ControlEvent {
  return { target: `timbre:${spirit}`, value: clamp01(value) };
}
