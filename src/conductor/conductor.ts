import { bus } from '../core/bus';
import type { NoteEvent, SpiritId } from '../core/contracts';
import type { Rng } from '../core/rng';
import type { Session } from '../core/session';
import { SLOTS_PER_BAR, SLOTS_PER_BEAT, secondsPerSlot } from '../core/time';
import { HarmonyChain } from './harmony';
import { euclid, rotate } from './patterns';
import { chordTones, scaleTones } from './scales';

// The conductor owns all musical decisions; the audio engine merely renders
// them. Tale of two clocks: a 25 ms tick scans a 120 ms horizon against the
// AudioContext clock and publishes sample-stamped NoteEvents to the bus.
// Every decision passes through the covenant: one scale, one root, one clock;
// chord-tone gravity on strong beats; register lanes; the onset budget;
// seeded humanisation; phrase arcs; graceful sleep.

const TICK_MS = 25;
const HORIZON_S = 0.12;
const JITTER_S = 0.008;
const DRUM_JITTER_S = 0.003;

/** Covenant rule 3: each spirit owns a tessitura band (midi, inclusive). */
export const LANES: Record<Exclude<SpiritId, 'world'>, readonly [number, number]> = {
  drum: [24, 48],
  rattle: [60, 84],
  root: [24, 36],
  voice: [60, 84],
  echo: [48, 72],
  spinner: [48, 84],
  breath: [36, 60],
};

/** Covenant rule 4 priority order; swells (drones, risers) are not attacks. */
const PRIORITY: readonly SpiritId[] = ['drum', 'root', 'voice', 'spinner', 'rattle', 'echo'];
const SWELLS = new Set(['drone', 'riser']);

type SpinnerShape = 'rise' | 'fall' | 'pendulum' | 'orbit';

export class Conductor {
  private slot = 0;
  private nextSlotTime = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly slotDur: number;
  private readonly rootPc: number;

  private readonly harmony: HarmonyChain;
  private chordDegree = 0;
  private chordPcs: number[];
  private scalePcs: number[];
  private chordChangeBars = 2;

  /** Seeded busyness defaults; the body drag takes these over in phase 3. */
  private readonly busy: Record<string, number> = {};
  /** Phrase arc phase offsets, one per spirit, so nobody breathes in unison. */
  private readonly arcPhase: Record<string, number> = {};

  private readonly kicks: boolean[];
  private readonly rootCycleSlots: number;
  private readonly rattlePattern: boolean[];
  private readonly spinnerGate: boolean[];
  private readonly spinnerShape: SpinnerShape;
  private spinnerIdx = 0;
  private spinnerDir = 1;

  private lastVoiceMidi: number | undefined;
  /** The Echo's ring buffer: the Voice's recent notes by slot. */
  private readonly voiceNotes = new Map<number, { midi: number; interval: number }>();
  private lastEchoMidi: number | undefined;
  private voiceSilentSlots = 0;

  constructor(
    private readonly session: Session,
    private readonly rng: Rng,
  ) {
    this.slotDur = secondsPerSlot(session.bpm);
    this.rootPc = session.moonPosition;
    this.harmony = new HarmonyChain(session.scaleIndex, rng.fork('harmony'));
    this.chordPcs = chordTones(session.scaleIndex, this.rootPc, 0);
    this.scalePcs = scaleTones(session.scaleIndex, this.rootPc);

    this.kicks = rotate(euclid(rng.pick([5, 7]), 16), rng.int(0, 15));
    this.rootCycleSlots = rng.pick([3, 4, 6]) * SLOTS_PER_BEAT;
    // The Rattle phases 12 against the bar's 16, Reich-fashion.
    this.rattlePattern = rotate(euclid(rng.int(4, 7), 12), rng.int(0, 11));
    this.spinnerGate = euclid(rng.int(9, 13), 16);
    this.spinnerShape = rng.pick(['rise', 'fall', 'pendulum', 'orbit'] as const);

    for (const id of PRIORITY) {
      this.busy[id] = rng.range(0.45, 0.7);
      this.arcPhase[id] = rng.next();
    }
    this.busy['breath'] = rng.range(0.45, 0.7);
    this.arcPhase['breath'] = rng.next();
  }

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

  private awake(id: SpiritId): boolean {
    return !this.session.asleep.has(id);
  }

  /** Covenant rule 6: a slow density envelope across the section. */
  private arc(id: string, bar: number): number {
    const barInSection = bar % this.session.sectionBars;
    const phase = (barInSection / this.session.sectionBars + (this.arcPhase[id] ?? 0)) * Math.PI * 2;
    return 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(phase));
  }

  private scheduleSlot(slot: number, time: number): void {
    const inBar = slot % SLOTS_PER_BAR;
    const bar = Math.floor(slot / SLOTS_PER_BAR);
    const pending: NoteEvent[] = [];

    if (inBar === 0) this.onBar(bar, time, pending);

    if (this.awake('drum')) this.scheduleDrum(inBar, bar, time, pending);
    if (this.awake('root')) this.scheduleRoot(slot, time, pending);
    if (this.awake('rattle')) this.scheduleRattle(slot, inBar, bar, time, pending);
    if (this.awake('voice')) this.scheduleVoice(slot, inBar, bar, time, pending);
    if (this.awake('echo')) this.scheduleEcho(slot, inBar, time, pending);
    if (this.awake('spinner')) this.scheduleSpinner(slot, bar, time, pending);

    this.voiceNotes.delete(slot - SLOTS_PER_BAR * 2);

    for (const event of this.enforceBudget(pending)) {
      bus.publish('note', event);
    }
  }

  private onBar(bar: number, time: number, pending: NoteEvent[]): void {
    const barInSection = bar % this.session.sectionBars;
    const turn = barInSection === 0;

    if (turn) {
      this.chordChangeBars = this.rng.pick([2, 4]);
    }
    const chordChanged = bar % this.chordChangeBars === 0;
    if (chordChanged && bar > 0) {
      this.chordDegree = this.harmony.step();
      this.chordPcs = chordTones(this.session.scaleIndex, this.rootPc, this.chordDegree);
    }

    bus.publish('section', {
      bar,
      chordRoot: (this.rootPc + this.chordDegree) % 12,
      chordTones: this.chordPcs,
      scaleTones: this.scalePcs,
      turn,
    });

    if (this.awake('breath')) {
      // Drones on root and fifth; a riser leans into every section turn.
      if (chordChanged || turn) {
        const dur = this.chordChangeBars * SLOTS_PER_BAR * this.slotDur;
        const dronePc = (this.rootPc + this.chordDegree) % 12;
        const droneMidi = this.intoLane(36 + dronePc, LANES.breath);
        pending.push(this.swell('breath', time, 0.5, dur, 'drone', droneMidi));
        pending.push(
          this.swell('breath', time, 0.35, dur, 'drone', this.intoLane(droneMidi + 7, LANES.breath)),
        );
      }
      if (barInSection === this.session.sectionBars - 1) {
        pending.push(this.swell('breath', time, 0.55, SLOTS_PER_BAR * this.slotDur, 'riser'));
      }
    }
  }

  private scheduleDrum(inBar: number, bar: number, time: number, pending: NoteEvent[]): void {
    const jitter = this.rng.range(-DRUM_JITTER_S, DRUM_JITTER_S);
    if (inBar === SLOTS_PER_BEAT || inBar === SLOTS_PER_BEAT * 3) {
      pending.push(this.note('drum', time + jitter, 0.7 + this.rng.range(-0.05, 0.05), 0.2, 'snare'));
      return;
    }
    if (this.kicks[inBar % 16]) {
      const vel = inBar === 0 ? 0.95 : 0.6 + 0.25 * this.arc('drum', bar) + this.rng.range(-0.08, 0.08);
      pending.push(this.note('drum', time + jitter, Math.min(1, vel), 0.3, 'kick'));
    }
    if (inBar === 14 && this.rng.chance(0.2 * this.arc('drum', bar))) {
      pending.push(this.note('drum', time + jitter, 0.55, 0.25, 'tom'));
    }
  }

  private scheduleRoot(slot: number, time: number, pending: NoteEvent[]): void {
    if (slot % this.rootCycleSlots !== 0) return;
    const r = this.rng.next();
    const interval = r < 0.6 ? 0 : r < 0.9 ? 7 : 12;
    // The Root follows the sounding chord, not just the scale root.
    const midi = this.intoLane(24 + ((this.rootPc + this.chordDegree) % 12) + interval, LANES.root);
    const duration = this.rootCycleSlots * this.slotDur * 0.85;
    const jitter = this.rng.range(-JITTER_S, JITTER_S);
    pending.push(
      this.note('root', time + jitter, 0.75 + this.rng.range(-0.06, 0.06), duration, 'pluck', midi),
    );
  }

  private scheduleRattle(
    slot: number,
    inBar: number,
    bar: number,
    time: number,
    pending: NoteEvent[],
  ): void {
    if (!this.rattlePattern[slot % 12]) return;
    // Never on the Drum's accents: the downbeat kick owns slot zero.
    if (inBar === 0) return;
    const p = 0.35 + 0.65 * (this.busy['rattle'] ?? 0.5) * this.arc('rattle', bar);
    if (!this.rng.chance(p)) return;
    const ghost = this.rng.chance(0.55);
    const vel = ghost ? this.rng.range(0.2, 0.38) : this.rng.range(0.42, 0.6);
    const pc = this.rng.pick(this.scalePcs);
    const midi = this.intoLane(60 + pc, LANES.rattle);
    const jitter = this.rng.range(-JITTER_S, JITTER_S);
    pending.push(
      this.note('rattle', time + jitter, vel, 0.15, ghost ? 'ghost' : 'hit', midi),
    );
  }

  private scheduleVoice(
    slot: number,
    inBar: number,
    bar: number,
    time: number,
    pending: NoteEvent[],
  ): void {
    const strong = inBar === 0 || inBar === SLOTS_PER_BEAT * 2;
    const onEighth = inBar % 2 === 0;
    let p =
      (this.busy['voice'] ?? 0.5) *
      this.arc('voice', bar) *
      (strong ? 0.75 : onEighth ? 0.4 : 0.1);
    // Real rests: breathe out at the tails of two-bar phrases.
    if (bar % 2 === 1 && inBar >= 12) p *= 0.15;

    if (!this.rng.chance(p)) {
      this.voiceSilentSlots += 1;
      return;
    }
    this.voiceSilentSlots = 0;

    // Covenant rule 2: chord tones on strong beats, scale tones on weak.
    const pool = strong ? this.chordPcs : this.scalePcs;
    const midi = this.pickStepwise(pool, LANES.voice, this.lastVoiceMidi);
    const interval = this.lastVoiceMidi === undefined ? 0 : midi - this.lastVoiceMidi;
    this.lastVoiceMidi = midi;
    this.voiceNotes.set(slot, { midi, interval });

    const durSlots = this.rng.pick(strong ? [2, 3, 4] : [1, 2]);
    const vel = 0.5 + 0.3 * this.arc('voice', bar) + this.rng.range(-0.05, 0.05);
    const jitter = this.rng.range(-JITTER_S, JITTER_S);
    pending.push(
      this.note('voice', time + jitter, Math.min(1, vel), durSlots * this.slotDur, 'lead', midi),
    );
  }

  private scheduleEcho(slot: number, inBar: number, time: number, pending: NoteEvent[]): void {
    const strong = inBar === 0 || inBar === SLOTS_PER_BEAT * 2;

    // When the Voice rests a while, the Echo turns to slow dyads on the chord.
    if (this.voiceSilentSlots > SLOTS_PER_BAR && inBar === 0) {
      const root = this.intoLane(48 + (this.chordPcs[0] ?? 0), LANES.echo);
      const dur = SLOTS_PER_BAR * this.slotDur;
      pending.push(this.note('echo', time, 0.4, dur, 'dyad', root));
      pending.push(this.note('echo', time, 0.32, dur, 'dyad', this.intoLane(root + 7, LANES.echo)));
      return;
    }

    // Imitation: the Voice's line, two beats late, transposed into our lane,
    // with a contrary-motion bias.
    const source = this.voiceNotes.get(slot - SLOTS_PER_BEAT * 2);
    if (!source) return;
    let midi: number;
    if (this.lastEchoMidi === undefined) {
      midi = this.snapToScale(source.midi - 12, LANES.echo);
    } else {
      midi = this.snapToScale(this.lastEchoMidi - source.interval, LANES.echo);
    }
    // Strong-beat consonance: no 2nds or 7ths against the sounding Voice note.
    const sounding = this.voiceNotes.get(slot)?.midi ?? this.lastVoiceMidi;
    if (strong && sounding !== undefined) {
      const ic = Math.abs(midi - sounding) % 12;
      if (ic === 1 || ic === 2 || ic === 10 || ic === 11) {
        midi = this.nearestInPool(this.chordPcs, LANES.echo, midi);
      }
    }
    this.lastEchoMidi = midi;
    const jitter = this.rng.range(-JITTER_S, JITTER_S);
    pending.push(
      this.note('echo', time + jitter, 0.45, this.slotDur * this.rng.pick([2, 3, 4]), 'bow', midi),
    );
  }

  private scheduleSpinner(slot: number, bar: number, time: number, pending: NoteEvent[]): void {
    if (!this.spinnerGate[slot % 16]) return;
    if (!this.rng.chance(0.4 + 0.6 * (this.busy['spinner'] ?? 0.5) * this.arc('spinner', bar))) {
      return;
    }
    const pool = [...new Set([...this.chordPcs, ...this.scalePcs])];
    const midis: number[] = [];
    const [lo, hi] = LANES.spinner;
    for (let m = lo; m <= hi; m++) {
      if (pool.includes(((m % 12) + 12) % 12)) midis.push(m);
    }
    if (midis.length === 0) return;

    switch (this.spinnerShape) {
      case 'rise':
        this.spinnerIdx = (this.spinnerIdx + 1) % midis.length;
        break;
      case 'fall':
        this.spinnerIdx = (this.spinnerIdx - 1 + midis.length) % midis.length;
        break;
      case 'pendulum':
        this.spinnerIdx += this.spinnerDir;
        if (this.spinnerIdx >= midis.length - 1 || this.spinnerIdx <= 0) this.spinnerDir *= -1;
        this.spinnerIdx = Math.max(0, Math.min(midis.length - 1, this.spinnerIdx));
        break;
      case 'orbit':
        this.spinnerIdx = (this.spinnerIdx + 5) % midis.length;
        break;
    }
    const midi = midis[this.spinnerIdx] as number;
    const jitter = this.rng.range(-JITTER_S, JITTER_S);
    pending.push(
      this.note('spinner', time + jitter, 0.32 + 0.2 * this.arc('spinner', bar), this.slotDur, 'tine', midi),
    );
  }

  /**
   * Covenant rule 4: at most 3 attacks per slot; the cap stretches to 4 when
   * the Drum + Root pairing lands together. Swells never count. Lower
   * priority drops first.
   */
  private enforceBudget(pending: NoteEvent[]): NoteEvent[] {
    const attacks = pending.filter((e) => !SWELLS.has(e.articulation ?? ''));
    const hasDrum = attacks.some((e) => e.spirit === 'drum');
    const hasRoot = attacks.some((e) => e.spirit === 'root');
    const cap = hasDrum && hasRoot ? 4 : 3;
    if (attacks.length <= cap) return pending;

    const rank = (e: NoteEvent): number => {
      const i = PRIORITY.indexOf(e.spirit);
      return i === -1 ? PRIORITY.length : i;
    };
    const kept = new Set(
      [...attacks].sort((a, b) => rank(a) - rank(b)).slice(0, cap),
    );
    return pending.filter((e) => SWELLS.has(e.articulation ?? '') || kept.has(e));
  }

  /** Fold a midi note into a lane, preserving pitch class. */
  private intoLane(midi: number, lane: readonly [number, number]): number {
    let m = midi;
    while (m > lane[1]) m -= 12;
    while (m < lane[0]) m += 12;
    return m;
  }

  /** The nearest in-lane midi whose pitch class sits in the pool. */
  private nearestInPool(pool: number[], lane: readonly [number, number], target: number): number {
    let best = target;
    let bestDist = Infinity;
    for (let m = lane[0]; m <= lane[1]; m++) {
      if (!pool.includes(((m % 12) + 12) % 12)) continue;
      const d = Math.abs(m - target);
      if (d < bestDist) {
        bestDist = d;
        best = m;
      }
    }
    return best;
  }

  private snapToScale(midi: number, lane: readonly [number, number]): number {
    return this.nearestInPool(this.scalePcs, lane, this.intoLane(midi, lane));
  }

  /** Weighted stepwise choice: near notes likely, leaps rare but alive. */
  private pickStepwise(
    pool: number[],
    lane: readonly [number, number],
    last: number | undefined,
  ): number {
    const candidates: number[] = [];
    for (let m = lane[0]; m <= lane[1]; m++) {
      if (pool.includes(((m % 12) + 12) % 12)) candidates.push(m);
    }
    if (candidates.length === 0) return lane[0];
    if (last === undefined) {
      return candidates[Math.floor(candidates.length / 2)] as number;
    }
    const flatten = this.rng.chance(0.1);
    const weights = candidates.map((m) => {
      const d = Math.abs(m - last);
      return flatten ? 1 : 1 / (1 + d * d * 0.35);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng.next() * total;
    for (let i = 0; i < candidates.length; i++) {
      r -= weights[i] as number;
      if (r <= 0) return candidates[i] as number;
    }
    return candidates[candidates.length - 1] as number;
  }

  private note(
    spirit: SpiritId,
    time: number,
    velocity: number,
    duration: number,
    articulation: string,
    midi?: number,
  ): NoteEvent {
    const event: NoteEvent = { spirit, time, velocity, duration, articulation };
    if (midi !== undefined) event.midi = midi;
    return event;
  }

  private swell(
    spirit: SpiritId,
    time: number,
    velocity: number,
    duration: number,
    articulation: string,
    midi?: number,
  ): NoteEvent {
    return this.note(spirit, time, velocity, duration, articulation, midi);
  }
}
