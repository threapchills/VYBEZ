import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../core/bus';
import type { NoteEvent, SectionEvent } from '../core/contracts';
import { Rng } from '../core/rng';
import { createSession } from '../core/session';
import { Conductor, LANES } from './conductor';

// The covenant under test: one scale one root one clock (rule 1), chord-tone
// gravity on strong beats (rule 2), register lanes (rule 3), the onset
// budget (rule 4), plus determinism and the conductor's own grid.

const SWELLS = new Set(['drone', 'riser']);
const GRID_START = 0.1;

describe('conductor', () => {
  const notes: NoteEvent[] = [];
  const sections: SectionEvent[] = [];
  const offs: Array<() => void> = [];

  beforeEach(() => {
    notes.length = 0;
    sections.length = 0;
    offs.push(bus.subscribe('note', (e) => notes.push(e)));
    offs.push(bus.subscribe('section', (e) => sections.push(e)));
  });

  afterEach(() => {
    for (const off of offs) off();
    offs.length = 0;
  });

  function run(seed: number, seconds: number) {
    const rng = new Rng(seed);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.start(() => 0);
    conductor.stop();
    for (let t = 0; t < seconds; t += 0.025) {
      conductor.tick(t);
    }
    const slotDur = 60 / session.bpm / 4;
    const slotOf = (time: number): number => Math.round((time - GRID_START) / slotDur);
    return { session, slotDur, slotOf };
  }

  it('is deterministic under a fixed seed', () => {
    run(42, 12);
    const first = notes.map((n) => `${n.spirit}:${n.time.toFixed(6)}:${n.midi ?? ''}`);
    notes.length = 0;
    sections.length = 0;
    run(42, 12);
    const second = notes.map((n) => `${n.spirit}:${n.time.toFixed(6)}:${n.midi ?? ''}`);
    expect(second).toEqual(first);
  });

  it('rule 1: every pitched note quantises to the broadcast harmony', () => {
    run(7, 60);
    const allowed = new Set<number>();
    for (const s of sections) {
      for (const pc of s.scaleTones) allowed.add(pc);
      for (const pc of s.chordTones) allowed.add(pc);
    }
    expect(notes.length).toBeGreaterThan(50);
    for (const n of notes) {
      if (n.midi === undefined || n.spirit === 'drum') continue;
      expect(allowed.has(((n.midi % 12) + 12) % 12)).toBe(true);
    }
  });

  it('rule 2: the Voice lands chord tones on strong beats', () => {
    const { slotOf } = run(13, 90);
    const chordByBar = new Map<number, number[]>();
    for (const s of sections) chordByBar.set(s.bar, s.chordTones);
    let strongCount = 0;
    for (const n of notes.filter((n) => n.spirit === 'voice')) {
      const slot = slotOf(n.time);
      const inBar = ((slot % 16) + 16) % 16;
      if (inBar !== 0 && inBar !== 8) continue;
      strongCount += 1;
      const chord = chordByBar.get(Math.floor(slot / 16));
      expect(chord).toBeDefined();
      expect(chord).toContain((((n.midi ?? 0) % 12) + 12) % 12);
    }
    expect(strongCount).toBeGreaterThan(0);
  });

  it('rule 3: every spirit stays inside its register lane', () => {
    run(99, 60);
    for (const n of notes) {
      if (n.midi === undefined || n.spirit === 'world') continue;
      const lane = LANES[n.spirit as keyof typeof LANES];
      expect(n.midi).toBeGreaterThanOrEqual(lane[0]);
      expect(n.midi).toBeLessThanOrEqual(lane[1]);
    }
  });

  it('rule 4: the onset budget holds in every slot', () => {
    const { slotOf } = run(3, 120);
    const bySlot = new Map<number, NoteEvent[]>();
    for (const n of notes) {
      if (SWELLS.has(n.articulation ?? '')) continue;
      const slot = slotOf(n.time);
      const list = bySlot.get(slot) ?? [];
      list.push(n);
      bySlot.set(slot, list);
    }
    for (const attacks of bySlot.values()) {
      const hasDrum = attacks.some((e) => e.spirit === 'drum');
      const hasRoot = attacks.some((e) => e.spirit === 'root');
      const cap = hasDrum && hasRoot ? 4 : 3;
      expect(attacks.length).toBeLessThanOrEqual(cap);
    }
  });

  it('publishes one section per bar and marks the turns', () => {
    const { session } = run(11, 60);
    expect(sections.length).toBeGreaterThan(10);
    expect(sections[0]?.turn).toBe(true);
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i]?.bar).toBe((sections[i - 1]?.bar ?? 0) + 1);
      expect(sections[i]?.turn).toBe((sections[i]?.bar ?? 0) % session.sectionBars === 0);
    }
  });

  it('drum jitter stays within three milliseconds of the grid', () => {
    const { slotDur } = run(11, 30);
    for (const n of notes.filter((n) => n.spirit === 'drum')) {
      const gridTime = n.time - GRID_START;
      const nearest = Math.round(gridTime / slotDur) * slotDur;
      expect(Math.abs(gridTime - nearest)).toBeLessThanOrEqual(0.003 + 1e-9);
    }
  });

  it('sleepers stay silent', () => {
    const { session } = run(21, 30);
    for (const n of notes) {
      expect(session.asleep.has(n.spirit)).toBe(false);
    }
  });
});
