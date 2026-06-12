import { describe, expect, it } from 'vitest';
import { SCALES, chordTones, scaleTones } from './scales';

describe('scales', () => {
  it('has seven scales in totem order', () => {
    expect(SCALES.map((s) => s.name)).toEqual([
      'aeolian',
      'harmonic minor',
      'hungarian minor',
      'double harmonic',
      'blues minor pentatonic',
      'major pentatonic',
      'ionian',
    ]);
  });

  it('matches the handoff semitone sets exactly', () => {
    expect(SCALES.map((s) => [...s.set])).toEqual([
      [0, 2, 3, 5, 7, 8, 10],
      [0, 2, 3, 5, 7, 8, 11],
      [0, 2, 3, 6, 7, 8, 11],
      [0, 1, 4, 5, 7, 8, 11],
      [0, 3, 5, 7, 10],
      [0, 2, 4, 7, 9],
      [0, 2, 4, 5, 7, 9, 11],
    ]);
  });

  it('harmony weights sum to one per scale', () => {
    for (const scale of SCALES) {
      const sum = scale.harmony.reduce((acc, h) => acc + h.weight, 0);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it('every harmony degree is in its scale set, except the documented drone', () => {
    for (const scale of SCALES) {
      for (const h of scale.harmony) {
        // Hungarian minor carries an iv-drone (5) against its raised fourth,
        // exactly as the handoff tables it.
        if (scale.name === 'hungarian minor' && h.degree === 5) continue;
        expect(scale.set).toContain(h.degree);
      }
    }
  });

  it('builds a diatonic triad in aeolian', () => {
    // A aeolian (root pitch class 9): i = A C E.
    expect(chordTones(0, 9, 0).sort((a, b) => a - b)).toEqual([0, 4, 9]);
  });

  it('keeps voicings open in the exotic and pentatonic scales', () => {
    expect(chordTones(3, 0, 0)).toEqual([0, 7]);
    expect(chordTones(4, 0, 0)).toEqual([0, 7]);
    expect(chordTones(5, 2, 0)).toEqual([2, 9]);
  });

  it('transposes scale tones by the root', () => {
    expect(scaleTones(6, 2)).toEqual([2, 4, 6, 7, 9, 11, 1]);
  });
});
