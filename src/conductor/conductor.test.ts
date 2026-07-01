import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../core/bus';
import type { NoteEvent, SectionEvent } from '../core/contracts';
import { Rng } from '../core/rng';
import { createSession } from '../core/session';
import { Conductor, LANES } from './conductor';
import { scaleTones } from './scales';

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
      const cap = hasDrum && hasRoot ? 5 : 4;
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

  it('all seven spirits sound within the first bars', () => {
    // The opening is composed: everyone has entered by bar six.
    run(21, 40);
    const sounded = new Set(notes.map((n) => n.spirit));
    for (const id of ['drum', 'rattle', 'root', 'voice', 'echo', 'spinner', 'breath']) {
      expect(sounded.has(id as (typeof notes)[number]['spirit'])).toBe(true);
    }
  });

  it('the voice repeats itself: phrase openings share the motif rhythm', () => {
    // A composed line repeats; pure dice never would. Bars 8 and 10 open the
    // statement and varied-repeat phrases of the same motif (past the intro),
    // so their onset slots should largely coincide.
    const { slotOf } = run(17, 50);
    const slotsOfBar = (bar: number): Set<number> =>
      new Set(
        notes
          .filter((n) => n.spirit === 'voice')
          .map((n) => slotOf(n.time))
          .filter((s) => s >= bar * 16 && s < bar * 16 + 16)
          .map((s) => s % 16),
      );
    const a = slotsOfBar(8);
    const b = slotsOfBar(10);
    const shared = [...a].filter((s) => b.has(s));
    expect(a.size).toBeGreaterThan(2);
    expect(shared.length).toBeGreaterThanOrEqual(3);
  });

  it('a sky strum rings in the scale, never a wrong note', () => {
    const rng = new Rng(12);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.start(() => 0);
    conductor.stop();
    notes.length = 0;
    conductor.handleControl({ target: 'strum', value: 0.5, y: 0.3 });
    const strums = notes.filter((n) => n.spirit === 'spinner');
    expect(strums.length).toBe(1);
    const scale = new Set(scaleTones(session.scaleIndex, session.moonPosition));
    expect(scale.has((((strums[0]?.midi ?? 0) % 12) + 12) % 12)).toBe(true);
  });

  it('stoking to a blaze holds the breath then drops a tutti', () => {
    const rng = new Rng(9);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.start(() => 0);
    conductor.stop();
    for (let t = 0; t < 30; t += 0.025) conductor.tick(t);
    const slotDur = 60 / session.bpm / 4;
    const armBar = Math.floor((conductor as unknown as { slot: number }).slot / 16);
    conductor.handleControl({ target: 'fire', value: 1 });
    const blazeBar = armBar + 1;
    for (let t = 30; t < 30 + slotDur * 48; t += 0.025) conductor.tick(t);
    const slotOf = (time: number): number => Math.round((time - GRID_START) / slotDur);
    const inBlaze = notes.filter(
      (n) => n.spirit === 'drum' && Math.floor(slotOf(n.time) / 16) === blazeBar,
    );
    const firstHalf = inBlaze.filter((n) => slotOf(n.time) % 16 < 8);
    const downbeat = inBlaze.filter((n) => slotOf(n.time) % 16 === 8 && n.velocity > 0.9);
    expect(firstHalf.length).toBe(0);
    expect(downbeat.length).toBeGreaterThan(0);
  });

  it('the totem changes the scale live', () => {
    const rng = new Rng(5);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.handleControl({ target: 'totem', value: 6 }); // ionian
    conductor.handleControl({ target: 'moon', value: 0 }); // root C
    conductor.tick(0.2);
    const ionianFromC = [0, 2, 4, 5, 7, 9, 11];
    expect(
      sections
        .at(-1)
        ?.scaleTones.slice()
        .sort((a, b) => a - b),
    ).toEqual(ionianFromC);
  });

  it('the moon changes the root live', () => {
    const rng = new Rng(5);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.handleControl({ target: 'moon', value: 5 });
    conductor.tick(0.2);
    expect(sections.at(-1)?.chordRoot).toBe(5);
  });

  it('sleeping a spirit announces it and fades it out gracefully', () => {
    const wakes: Array<{ spirit: string; awake: boolean }> = [];
    offs.push(bus.subscribe('wake', (e) => wakes.push(e)));
    const rng = new Rng(8);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.handleControl({ target: 'wake:drum', value: 0 }); // the drum starts awake
    for (let t = 0; t < 20; t += 0.025) conductor.tick(t);
    // The sleep is announced at once for the visual transition.
    expect(wakes.some((w) => w.spirit === 'drum' && !w.awake)).toBe(true);
    // It thins over two bars, then falls silent: nothing in the last stretch.
    const late = notes.filter((n) => n.spirit === 'drum' && n.time > 12);
    expect(late.length).toBe(0);
  });

  it('a gale makes the valley play itself', () => {
    const controls: Array<{ target: string }> = [];
    offs.push(bus.subscribe('control', (e) => controls.push(e)));
    const rng = new Rng(4);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.handleControl({ target: 'wind', value: 2 }); // gale
    for (let t = 0; t < 240; t += 0.025) conductor.tick(t);
    expect(controls.length).toBeGreaterThan(0);
  });

  it('stillness freezes autonomous drift', () => {
    const controls: Array<{ target: string }> = [];
    offs.push(bus.subscribe('control', (e) => controls.push(e)));
    const rng = new Rng(4);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    // Still is a choice now, not the default: ask for it, then nothing drifts.
    conductor.handleControl({ target: 'wind', value: 0 });
    for (let t = 0; t < 240; t += 0.025) conductor.tick(t);
    expect(controls.length).toBe(0);
  });

  it('the default breeze drifts the valley on its own', () => {
    const controls: Array<{ target: string }> = [];
    offs.push(bus.subscribe('control', (e) => controls.push(e)));
    const rng = new Rng(4);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    for (let t = 0; t < 240; t += 0.025) conductor.tick(t);
    expect(controls.length).toBeGreaterThan(0);
  });

  it('a control change answers with an immediate audible gesture', () => {
    const rng = new Rng(6);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.start(() => 1);
    conductor.stop();
    notes.length = 0;
    conductor.handleControl({ target: 'totem', value: 3 });
    // The totem answers with three rising tines in the new scale.
    expect(notes.filter((n) => n.spirit === 'spinner').length).toBe(3);
    notes.length = 0;
    conductor.handleControl({ target: 'moon', value: 7 });
    expect(notes.some((n) => n.spirit === 'root' && n.midi !== undefined && n.midi % 12 === 7)).toBe(
      true,
    );
  });
});
