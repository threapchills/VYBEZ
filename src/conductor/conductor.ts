import { bus } from '../core/bus';
import type { NoteEvent } from '../core/contracts';
import type { Rng } from '../core/rng';
import type { Session } from '../core/session';
import { SLOTS_PER_BAR, SLOTS_PER_BEAT, secondsPerSlot } from '../core/time';
import { euclid, rotate } from './patterns';
import { chordTones, scaleTones } from './scales';

// The conductor owns all musical decisions; the audio engine merely renders
// them. Tale of two clocks: a 25 ms tick scans a 120 ms horizon against the
// AudioContext clock and publishes sample-stamped NoteEvents to the bus.

const TICK_MS = 25;
const HORIZON_S = 0.12;
/** Covenant rule 5: seeded timing jitter, tighter for the Drum. */
const JITTER_S = 0.008;
const DRUM_JITTER_S = 0.003;

export class Conductor {
  private slot = 0;
  private nextSlotTime = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly slotDur: number;
  private readonly rootPc: number;

  // Drum vocabulary: seeded Euclidean kick backbone plus the backbeat.
  private readonly kicks: boolean[];
  // Root vocabulary: a hemiola cycle of 3, 4 or 6 beats against the 4-beat bar.
  private readonly rootCycleSlots: number;

  constructor(
    private readonly session: Session,
    private readonly rng: Rng,
  ) {
    this.slotDur = secondsPerSlot(session.bpm);
    this.rootPc = session.moonPosition;
    this.kicks = rotate(euclid(rng.pick([5, 7]), 16), rng.int(0, 15));
    this.rootCycleSlots = rng.pick([3, 4, 6]) * SLOTS_PER_BEAT;
  }

  /** Begin at the next moment; now() must read the AudioContext clock. */
  start(now: () => number): void {
    if (this.timer !== undefined) return;
    this.nextSlotTime = now() + 0.1;
    this.timer = setInterval(() => this.tick(now()), TICK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Schedule every slot inside the horizon. Public for tests. */
  tick(now: number): void {
    while (this.nextSlotTime < now + HORIZON_S) {
      this.scheduleSlot(this.slot, this.nextSlotTime);
      this.slot += 1;
      this.nextSlotTime += this.slotDur;
    }
  }

  private scheduleSlot(slot: number, time: number): void {
    const inBar = slot % SLOTS_PER_BAR;

    if (inBar === 0) {
      const bar = slot / SLOTS_PER_BAR;
      bus.publish('section', {
        bar,
        chordRoot: this.rootPc,
        chordTones: chordTones(this.session.scaleIndex, this.rootPc, 0),
        scaleTones: scaleTones(this.session.scaleIndex, this.rootPc),
        turn: bar % this.session.sectionBars === 0,
      });
    }

    this.scheduleDrum(inBar, time);
    this.scheduleRoot(slot, time);
  }

  private scheduleDrum(inBar: number, time: number): void {
    const jitter = this.rng.range(-DRUM_JITTER_S, DRUM_JITTER_S);
    // Backbeat membrane on beats 2 and 4.
    if (inBar === SLOTS_PER_BEAT || inBar === SLOTS_PER_BEAT * 3) {
      this.note('drum', time + jitter, 0.7 + this.rng.range(-0.05, 0.05), 0.2, 'snare');
      return;
    }
    if (this.kicks[inBar % 16]) {
      // Velocity contour: the downbeat carries the weight.
      const vel = inBar === 0 ? 0.95 : 0.7 + this.rng.range(-0.08, 0.08);
      this.note('drum', time + jitter, vel, 0.3, 'kick');
    }
    // A sparse tom answer at the bar's tail, seeded.
    if (inBar === 14 && this.rng.chance(0.2)) {
      this.note('drum', time + jitter, 0.55, 0.25, 'tom');
    }
  }

  private scheduleRoot(slot: number, time: number): void {
    if (slot % this.rootCycleSlots !== 0) return;
    // Root and fifth gravity: mostly the root, sometimes the fifth, rarely up an octave.
    const r = this.rng.next();
    const interval = r < 0.6 ? 0 : r < 0.9 ? 7 : 12;
    // C1 to C2 lane (midi 24 to 36); fold anything that escapes back down.
    let midi = 24 + this.rootPc + interval;
    while (midi > 36) midi -= 12;
    const duration = this.rootCycleSlots * this.slotDur * 0.85;
    const jitter = this.rng.range(-JITTER_S, JITTER_S);
    this.note('root', time + jitter, 0.75 + this.rng.range(-0.06, 0.06), duration, 'pluck', midi);
  }

  private note(
    spirit: NoteEvent['spirit'],
    time: number,
    velocity: number,
    duration: number,
    articulation: string,
    midi?: number,
  ): void {
    const event: NoteEvent = { spirit, time, velocity, duration, articulation };
    if (midi !== undefined) event.midi = midi;
    bus.publish('note', event);
  }
}
