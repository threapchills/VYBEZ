import { describe, expect, it } from 'vitest';
import { SCALES } from '../conductor/scales';
import {
  MOON_HUE_RANGE,
  RAMPS,
  fireWarmth,
  hexToRgb,
  lerpRamp,
  moonHueRotation,
  paletteStops,
  rgbToHex,
  rotateHue,
  toTint,
  warmMidtone,
} from './palette';

const HEX = /^#[0-9a-f]{6}$/i;

describe('ramps', () => {
  it('has one five-stop ramp per scale', () => {
    expect(RAMPS.length).toBe(SCALES.length);
    for (const ramp of RAMPS) {
      expect(ramp.length).toBe(5);
      for (const stop of ramp) expect(stop).toMatch(HEX);
    }
  });
});

describe('hex and rgb round-trip', () => {
  it('survives the journey', () => {
    expect(rgbToHex(hexToRgb('#1a2c40'))).toBe('#1a2c40');
    expect(hexToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
  });
});

describe('moon hue rotation', () => {
  it('never leaves the +-25 degree band', () => {
    for (let pos = -5; pos <= 16; pos++) {
      expect(Math.abs(moonHueRotation(pos))).toBeLessThanOrEqual(MOON_HUE_RANGE + 1e-9);
    }
  });

  it('spans the band end to end', () => {
    expect(moonHueRotation(0)).toBeCloseTo(-MOON_HUE_RANGE, 6);
    expect(moonHueRotation(11)).toBeCloseTo(MOON_HUE_RANGE, 6);
    expect(moonHueRotation(5.5)).toBeCloseTo(0, 6);
  });

  it('leaves greys untouched', () => {
    expect(rotateHue('#808080', 25)).toBe('#808080');
  });
});

describe('fire warming', () => {
  it('maps the fire band to 0..1', () => {
    expect(fireWarmth(0.35)).toBe(0);
    expect(fireWarmth(1)).toBe(1);
    expect(fireWarmth(0)).toBe(0);
  });

  it('pushes a midtone toward ember: more red, less blue', () => {
    const cool = hexToRgb('#5b7c8d');
    const warm = hexToRgb(warmMidtone('#5b7c8d', 1));
    expect(warm.r).toBeGreaterThan(cool.r);
    expect(warm.b).toBeLessThan(cool.b);
  });
});

describe('paletteStops', () => {
  it('returns five valid hex stops and is deterministic', () => {
    const a = paletteStops(2, 7, 0.8);
    const b = paletteStops(2, 7, 0.8);
    expect(a).toEqual(b);
    expect(a.length).toBe(5);
    for (const stop of a) expect(stop).toMatch(HEX);
  });

  it('clamps an out-of-range scale index', () => {
    expect(paletteStops(99, 0, 0.5).length).toBe(5);
    expect(paletteStops(-3, 0, 0.5).length).toBe(5);
  });

  it('a hotter fire warms a midtone relative to the floor', () => {
    const cold = hexToRgb(paletteStops(0, 5, 0.35)[2] as string);
    const hot = hexToRgb(paletteStops(0, 5, 1)[2] as string);
    expect(hot.r).toBeGreaterThan(cold.r);
  });
});

describe('lerpRamp', () => {
  it('returns the endpoints at t = 0 and t = 1', () => {
    const a = RAMPS[0] as string[];
    const b = RAMPS[6] as string[];
    expect(lerpRamp(a, b, 0)).toEqual([...a]);
    expect(lerpRamp(a, b, 1)).toEqual([...b]);
  });

  it('sits between the endpoints at the midpoint', () => {
    const mid = lerpRamp(['#000000'], ['#ffffff'], 0.5);
    expect(hexToRgb(mid[0] as string).r).toBeCloseTo(128, -1);
  });
});

describe('toTint', () => {
  it('gives Pixi a 0xRRGGBB integer', () => {
    expect(toTint('#ff8000')).toBe(0xff8000);
    expect(toTint('#000000')).toBe(0);
  });
});
