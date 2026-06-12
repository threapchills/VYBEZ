import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import { createSession } from './session';

describe('createSession', () => {
  it('always sleeps 2 to 4 spirits and keeps a tonal anchor awake', () => {
    for (let seed = 0; seed < 500; seed++) {
      const s = createSession(new Rng(seed));
      expect(s.asleep.size).toBeGreaterThanOrEqual(2);
      expect(s.asleep.size).toBeLessThanOrEqual(4);
      expect(s.asleep.has('root') && s.asleep.has('breath')).toBe(false);
      expect(s.asleep.has('world')).toBe(false);
    }
  });

  it('stays inside the dials', () => {
    for (let seed = 0; seed < 200; seed++) {
      const s = createSession(new Rng(seed));
      expect(s.scaleIndex).toBeGreaterThanOrEqual(0);
      expect(s.scaleIndex).toBeLessThanOrEqual(6);
      expect(s.moonPosition).toBeGreaterThanOrEqual(0);
      expect(s.moonPosition).toBeLessThanOrEqual(11);
      expect(s.bpm).toBeGreaterThanOrEqual(60);
      expect(s.bpm).toBeLessThanOrEqual(92);
      expect((s.bpm - 60) % 4).toBe(0);
      expect([8, 16]).toContain(s.sectionBars);
    }
  });

  it('is deterministic', () => {
    const a = createSession(new Rng(123));
    const b = createSession(new Rng(123));
    expect([...a.asleep].sort()).toEqual([...b.asleep].sort());
    expect(a.bpm).toBe(b.bpm);
    expect(a.moonPosition).toBe(b.moonPosition);
  });
});
