import type { PaletteEvent } from '../core/contracts';

// The palette engine: seven base ramps, one per scale, each a five-stop ramp
// dark to light. The moon's position rotates accent hues within a clamped
// range; the fire warms the midtones; section turns ease one stop over time,
// which the visual layer drives by lerping between ramps. Hue rotation stays
// inside +-25 degrees so the painted art never breaks, exactly as the brief
// requires. All maths here is pure: no Pixi, no DOM, no bus.

/** Ramps in the same order as SCALES: aeolian first, ionian last. */
export const RAMPS: readonly (readonly string[])[] = [
  ['#0b1026', '#243b53', '#5b7c8d', '#a8b8a6', '#e8e3cf'], // aeolian
  ['#140a1e', '#3c1430', '#7a2742', '#b35a4a', '#e8c9a0'], // harmonic minor
  ['#120f1a', '#38203f', '#74356b', '#b05a7e', '#ead0c2'], // hungarian minor
  ['#0d0b1f', '#2a2150', '#6b4d2e', '#c08a3e', '#f2dca6'], // double harmonic
  ['#0a1418', '#16323e', '#2f5d63', '#8a6a45', '#d8a05c'], // blues minor pentatonic
  ['#0c1714', '#1f4034', '#4f7a5a', '#a3b86c', '#f2e2b6'], // major pentatonic
  ['#1a1430', '#4a2e57', '#95566b', '#d9926f', '#ffe3b3'], // ionian
] as const;

/** Never rotate hue beyond this, in degrees. */
export const MOON_HUE_RANGE = 25;

const FIRE_FLOOR = 0.35;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const hue = ((h % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: channel(hue + 1 / 3) * 255,
    g: channel(hue) * 255,
    b: channel(hue - 1 / 3) * 255,
  };
}

/** Rotate a colour's hue by a signed degree amount. */
export function rotateHue(hex: string, degrees: number): string {
  const hsl = rgbToHsl(hexToRgb(hex));
  if (hsl.s === 0) return hex; // greys carry no hue to rotate
  return rgbToHex(hslToRgb({ ...hsl, h: hsl.h + degrees }));
}

/** Moon position 0 to 11 maps to a hue rotation clamped to +-25 degrees. */
export function moonHueRotation(moonPosition: number): number {
  const pos = Math.max(0, Math.min(11, moonPosition));
  const rot = -MOON_HUE_RANGE + (pos / 11) * (MOON_HUE_RANGE * 2);
  return Math.max(-MOON_HUE_RANGE, Math.min(MOON_HUE_RANGE, rot));
}

/** Fire intensity 0.35 to 1 becomes a 0 to 1 warming amount. */
export function fireWarmth(fire: number): number {
  return Math.max(0, Math.min(1, (fire - FIRE_FLOOR) / (1 - FIRE_FLOOR)));
}

/** Nudge a midtone toward ember warmth: more red, less blue. */
export function warmMidtone(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const k = amount * 20;
  return rgbToHex({ r: r + k, g: g + k * 0.35, b: b - k * 0.6 });
}

/**
 * The live five-stop ramp for the current scale, moon and fire. The two darkest
 * and lightest stops keep their footing; the three midtones take the warmth.
 */
export function paletteStops(scaleIndex: number, moonPosition: number, fire: number): string[] {
  const ramp = RAMPS[Math.max(0, Math.min(RAMPS.length - 1, scaleIndex))];
  if (!ramp) return [];
  const rot = moonHueRotation(moonPosition);
  const warmth = fireWarmth(fire);
  return ramp.map((hex, i) => {
    let c = rotateHue(hex, rot);
    if (i >= 1 && i <= 3) c = warmMidtone(c, warmth);
    return c;
  });
}

/** Convenience overload for a PaletteEvent straight off the bus. */
export function paletteFor(event: PaletteEvent): string[] {
  return paletteStops(event.scaleIndex, event.moonPosition, event.fire);
}

/** Ease between two ramps; the visual layer steps t across a section turn. */
export function lerpRamp(from: readonly string[], to: readonly string[], t: number): string[] {
  const clamped = Math.max(0, Math.min(1, t));
  const n = Math.min(from.length, to.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = hexToRgb(from[i] as string);
    const b = hexToRgb(to[i] as string);
    out.push(
      rgbToHex({
        r: a.r + (b.r - a.r) * clamped,
        g: a.g + (b.g - a.g) * clamped,
        b: a.b + (b.b - a.b) * clamped,
      }),
    );
  }
  return out;
}

/** A 0xRRGGBB integer tint, the form Pixi wants. */
export function toTint(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}
