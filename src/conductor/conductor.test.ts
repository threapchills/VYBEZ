import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bus } from '../core/bus';
import type { NoteEvent, SectionEvent } from '../core/contracts';
import { Rng } from '../core/rng';
import { createSession } from '../core/session';
import { Conductor } from './conductor';

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

  /** Drive the scheduler by hand across simulated seconds. */
  function run(seed: number, seconds: number): { bpm: number } {
    const rng = new Rng(seed);
    const session = createSession(rng.fork('session'));
    const conductor = new Conductor(session, rng.fork('conductor'));
    conductor.start(() => 0);
    conductor.stop();
    for (let t = 0; t < seconds; t += 0.025) {
      conductor.tick(t);
    }
    return { bpm: session.bpm };
  }

  it('is deterministic under a fixed seed', () => {
    run(42, 10);
    const first = notes.map((n) => `${n.spirit}:${n.time.toFixed(6)}:${n.midi ?? ''}`);
    notes.length = 0;
    sections.length = 0;
    run(42, 10);
    const second = notes.map((n) => `${n.spirit}:${n.time.toFixed(6)}:${n.midi ?? ''}`);
    expect(second).toEqual(first);
  });

  it('publishes one section event per bar with the chord broadcast', () => {
    const { bpm } = run(7, 30);
    const barSeconds = (60 / bpm) * 4;
    const expectedBars = Math.floor((30 + 0.12 - 0.1) / barSeconds) + 1;
    expect(Math.abs(sections.length - expectedBars)).toBeLessThanOrEqual(1);
    for (const s of sections) {
      expect(s.chordTones.length).toBeGreaterThanOrEqual(2);
      expect(s.scaleTones.length).toBeGreaterThanOrEqual(5);
    }
    expect(sections[0]?.turn).toBe(true);
  });

  it('keeps every note inside its lane and the covenant', () => {
    run(99, 30);
    expect(notes.length).toBeGreaterThan(20);
    for (const n of notes) {
      expect(['drum', 'root']).toContain(n.spirit);
      expect(n.velocity).toBeGreaterThan(0);
      expect(n.velocity).toBeLessThanOrEqual(1);
      if (n.spirit === 'root') {
        expect(n.midi).toBeGreaterThanOrEqual(24);
        expect(n.midi).toBeLessThanOrEqual(36);
      }
    }
  });

  it('never schedules two attacks in the same slot beyond drum plus root', () => {
    const { bpm } = run(3, 60);
    const slotDur = 60 / bpm / 4;
    const bySlot = new Map<number, number>();
    for (const n of notes) {
      const slot = Math.round(n.time / slotDur);
      bySlot.set(slot, (bySlot.get(slot) ?? 0) + 1);
    }
    for (const count of bySlot.values()) {
      expect(count).toBeLessThanOrEqual(2);
    }
  });

  it('drum timing jitter stays within three milliseconds', () => {
    const { bpm } = run(11, 30);
    const slotDur = 60 / bpm / 4;
    // The grid starts 0.1 s after start(); jitter is measured from that grid.
    for (const n of notes.filter((n) => n.spirit === 'drum')) {
      const gridTime = n.time - 0.1;
      const nearest = Math.round(gridTime / slotDur) * slotDur;
      expect(Math.abs(gridTime - nearest)).toBeLessThanOrEqual(0.003 + 1e-9);
    }
  });
});
