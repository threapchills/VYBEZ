import { describe, expect, it } from 'vitest';
import { PLAYABLE_SPIRITS } from '../core/contracts';
import {
  FIRE_CEIL,
  FIRE_FLOOR,
  busyEvent,
  censerEvent,
  decayFire,
  fireEvent,
  moonEvent,
  nextScaleNotch,
  nextWind,
  snapMoonPosition,
  stokeFire,
  timbreEvent,
  totemEvent,
  wakeEvent,
  windEvent,
  windFromValue,
  type WindState,
} from './controls';

describe('totem', () => {
  it('clicks upward and wraps at the top', () => {
    expect(nextScaleNotch(0)).toBe(1);
    expect(nextScaleNotch(5)).toBe(6);
    expect(nextScaleNotch(6)).toBe(0);
  });
});

describe('moon', () => {
  it('snaps the arc to one of twelve positions', () => {
    expect(snapMoonPosition(0)).toBe(0);
    expect(snapMoonPosition(1)).toBe(11);
    expect(snapMoonPosition(0.5)).toBe(6);
    expect(snapMoonPosition(-3)).toBe(0);
    expect(snapMoonPosition(9)).toBe(11);
  });
});

describe('censer', () => {
  it('settles to the nearest notch within range', () => {
    expect(censerEvent(61).value).toBe(60);
    expect(censerEvent(62).value).toBe(64);
    expect(censerEvent(200).value).toBe(92);
  });
});

describe('fire', () => {
  it('stokes toward the ceiling and clamps there', () => {
    expect(stokeFire(0.35)).toBeGreaterThan(0.35);
    expect(stokeFire(0.95)).toBe(FIRE_CEIL);
  });

  it('cools toward the floor but never beneath it', () => {
    const hot = 1.0;
    const after1s = decayFire(hot, 1);
    expect(after1s).toBeLessThan(hot);
    expect(after1s).toBeGreaterThan(FIRE_FLOOR);
    // After a long span it sits effectively on the floor.
    expect(decayFire(hot, 600)).toBeCloseTo(FIRE_FLOOR, 2);
    expect(decayFire(FIRE_FLOOR, 30)).toBe(FIRE_FLOOR);
  });

  it('roughly settles within three minutes', () => {
    // From a full blaze, most of the swing is gone by 180 s.
    const remaining = (decayFire(1.0, 180) - FIRE_FLOOR) / (1.0 - FIRE_FLOOR);
    expect(remaining).toBeLessThan(0.15);
  });

  it('clamps event payloads into the legal band', () => {
    expect(fireEvent(2).value).toBe(FIRE_CEIL);
    expect(fireEvent(0).value).toBe(FIRE_FLOOR);
  });
});

describe('wind', () => {
  it('cycles still, breeze, gale and back', () => {
    const seq: WindState[] = ['still'];
    for (let i = 0; i < 3; i++) seq.push(nextWind(seq[seq.length - 1] as WindState));
    expect(seq).toEqual(['still', 'breeze', 'gale', 'still']);
  });

  it('round-trips through its numeric value', () => {
    for (const state of ['still', 'breeze', 'gale'] as WindState[]) {
      expect(windFromValue(windEvent(state).value)).toBe(state);
    }
  });
});

describe('per-spirit events', () => {
  it('targets every playable spirit and clamps continuous drags', () => {
    for (const id of PLAYABLE_SPIRITS) {
      if (id === 'world') continue;
      expect(wakeEvent(id, true)).toEqual({ target: `wake:${id}`, value: 1 });
      expect(wakeEvent(id, false).value).toBe(0);
      expect(busyEvent(id, 2).value).toBe(1);
      expect(busyEvent(id, -1).value).toBe(0);
      expect(timbreEvent(id, 0.5).value).toBe(0.5);
    }
  });
});

describe('event targets match the contract list', () => {
  it('uses the documented target strings', () => {
    expect(totemEvent(0).target).toBe('totem');
    expect(moonEvent(0).target).toBe('moon');
    expect(censerEvent(60).target).toBe('censer');
    expect(fireEvent(0.5).target).toBe('fire');
    expect(windEvent('still').target).toBe('wind');
  });
});
