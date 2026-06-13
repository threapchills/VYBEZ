import { bus } from '../core/bus';
import { PLAYABLE_SPIRITS } from '../core/contracts';
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
  private unsubscribe: (() => void) | undefined;
  // These four are the live diegetic controls: the censer, moon and totem
  // move them, so they cannot be readonly.
  private slotDur: number;
  private rootPc: number;
  private scaleIndex: number;
  private harmony: HarmonyChain;
  /** Intended wake state, seeded from the session and toggled by tapping. */
  private readonly asleepNow: Set<SpiritId>;
  /**
   * Audible presence 0 to 1 per spirit; waking and sleeping ramp it over two
   * bars so patterns thin in and out rather than snapping (covenant rule 7).
   */
  private readonly presence: Record<string, number> = {};
  /** Tracked so palette broadcasts carry the current fire. */
  private fire: number;
  /** Still 0, breeze 1, gale 2; drives autonomous drift in phase 5. */
  private wind = 0;
  /** The conductor's own copy of each talisman position, so drift can walk it. */
  private readonly timbre: Record<string, number> = {};
  /** A dedicated stream for the wind's slow walks, kept off the music streams. */
  private readonly driftRng: Rng;

  private chordDegree = 0;
  private chordPcs: number[];
  private scalePcs: number[];
  private chordChangeBars = 2;

  /** Seeded busyness defaults; the body drag and the wind move them. */
  private readonly busy: Record<string, number> = {};
  /** Phrase arc phase offsets, one per spirit, so nobody breathes in unison. */
  private readonly arcPhase: Record<string, number> = {};

  // Patterns are reseeded by the wind and at section turns, so not readonly.
  private kicks: boolean[];
  private rootCycleSlots: number;
  private rattlePattern: boolean[];
  private spinnerGate: boolean[];
  private spinnerShape: SpinnerShape;
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
    this.scaleIndex = session.scaleIndex;
    this.fire = session.fire;
    this.harmony = new HarmonyChain(this.scaleIndex, rng.fork('harmony'));
    this.chordPcs = chordTones(this.scaleIndex, this.rootPc, 0);
    this.scalePcs = scaleTones(this.scaleIndex, this.rootPc);
    this.asleepNow = new Set(session.asleep);
    this.driftRng = rng.fork('drift');

    this.kicks = rotate(euclid(rng.pick([5, 7]), 16), rng.int(0, 15));
    this.rootCycleSlots = rng.pick([3, 4, 6]) * SLOTS_PER_BEAT;
    // The Rattle phases 12 against the bar's 16, Reich-fashion.
    this.rattlePattern = rotate(euclid(rng.int(4, 7), 12), rng.int(0, 11));
    this.spinnerGate = euclid(rng.int(9, 13), 16);
    this.spinnerShape = rng.pick(['rise', 'fall', 'pendulum', 'orbit'] as const);

    for (const id of [...PRIORITY, 'breath'] as SpiritId[]) {
      this.busy[id] = rng.range(0.45, 0.7);
      this.timbre[id] = rng.range(0.3, 0.7);
      this.arcPhase[id] = rng.next();
      this.presence[id] = this.asleepNow.has(id) ? 0 : 1;
    }
  }

  start(now: () => number): void {
    if (this.timer !== undefined) return;
    this.nextSlotTime = now() + 0.1;
    this.unsubscribe = bus.subscribe('control', (e) => this.handleControl(e));
    this.timer = setInterval(() => this.tick(now()), TICK_MS);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Schedule every slot inside the horizon. Public for tests. */
  tick(now: number): void {
    while (this.nextSlotTime < now + HORIZON_S) {
      this.scheduleSlot(this.slot, this.nextSlotTime);
      this.slot += 1;
      this.nextSlotTime += this.slotDur;
    }
  }

  /** A spirit sounds while it has any presence, so it can fade out gracefully. */
  private sounds(id: SpiritId): boolean {
    return (this.presence[id] ?? 0) > 0.001;
  }

  /**
   * Consume a control change from the interaction layer. Every control responds
   * live so the valley answers a touch within a beat. Targets follow the
   * contracts: totem, moon, censer, fire, wind, busy:<id>, wake:<id>. Timbre is
   * the engine's business and is ignored here.
   */
  handleControl(event: { target: string; value: number }): void {
    const { target, value } = event;
    if (target === 'totem') {
      this.scaleIndex = ((Math.round(value) % 7) + 7) % 7;
      this.harmony = new HarmonyChain(this.scaleIndex, this.rng.fork(`harmony:${this.slot}`));
      this.chordDegree = 0;
      this.refreshPitches();
      this.broadcastPalette();
      return;
    }
    if (target === 'moon') {
      this.rootPc = ((Math.round(value) % 12) + 12) % 12;
      this.refreshPitches();
      this.broadcastPalette();
      return;
    }
    if (target === 'censer') {
      this.slotDur = secondsPerSlot(value);
      return;
    }
    if (target === 'fire') {
      this.fire = value;
      this.broadcastPalette();
      return;
    }
    if (target === 'wind') {
      this.wind = Math.round(value);
      return;
    }
    const colon = target.indexOf(':');
    if (colon === -1) return;
    const kind = target.slice(0, colon);
    const id = target.slice(colon + 1) as SpiritId;
    if (kind === 'busy') {
      this.busy[id] = Math.max(0, Math.min(1, value));
    } else if (kind === 'timbre') {
      this.timbre[id] = Math.max(0, Math.min(1, value));
    } else if (kind === 'wake') {
      const wantAwake = value >= 0.5;
      // Intent flips at once; presence ramps over two bars so the part thins
      // in or out rather than snapping. The visual transition plays off this.
      if (wantAwake) this.asleepNow.delete(id);
      else this.asleepNow.add(id);
      bus.publish('wake', { spirit: id, awake: wantAwake });
    }
  }

  private refreshPitches(): void {
    this.chordPcs = chordTones(this.scaleIndex, this.rootPc, this.chordDegree);
    this.scalePcs = scaleTones(this.scaleIndex, this.rootPc);
  }

  private broadcastPalette(): void {
    bus.publish('palette', {
      scaleIndex: this.scaleIndex,
      moonPosition: this.rootPc,
      fire: this.fire,
    });
  }

  /** Covenant rule 6: a slow density envelope across the section. */
  private arc(id: string, bar: number): number {
    const barInSection = bar % this.session.sectionBars;
    const phase =
      (barInSection / this.session.sectionBars + (this.arcPhase[id] ?? 0)) * Math.PI * 2;
    return 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(phase));
  }

  private scheduleSlot(slot: number, time: number): void {
    const inBar = slot % SLOTS_PER_BAR;
    const bar = Math.floor(slot / SLOTS_PER_BAR);
    const pending: NoteEvent[] = [];

    if (inBar === 0) this.onBar(bar, time, pending);

    if (this.sounds('drum')) this.scheduleDrum(inBar, bar, time, pending);
    if (this.sounds('root')) this.scheduleRoot(slot, time, pending);
    if (this.sounds('rattle')) this.scheduleRattle(slot, inBar, bar, time, pending);
    if (this.sounds('voice')) this.scheduleVoice(slot, inBar, bar, time, pending);
    if (this.sounds('echo')) this.scheduleEcho(slot, inBar, time, pending);
    if (this.sounds('spinner')) this.scheduleSpinner(slot, bar, time, pending);

    this.voiceNotes.delete(slot - SLOTS_PER_BAR * 2);

    for (const event of this.enforceBudget(pending)) {
      bus.publish('note', event);
    }
  }

  private onBar(bar: number, time: number, pending: NoteEvent[]): void {
    const barInSection = bar % this.session.sectionBars;
    const turn = barInSection === 0;

    // Presence eases toward intent over two bars (covenant rule 7).
    for (const id of PLAYABLE_SPIRITS) {
      const target = this.asleepNow.has(id) ? 0 : 1;
      const cur = this.presence[id] ?? 0;
      this.presence[id] = cur + Math.max(-0.5, Math.min(0.5, target - cur));
    }

    if (turn) {
      this.chordChangeBars = this.rng.pick([2, 4]);
    }
    const chordChanged = bar % this.chordChangeBars === 0;
    if (chordChanged && bar > 0) {
      this.chordDegree = this.harmony.step();
      this.chordPcs = chordTones(this.scaleIndex, this.rootPc, this.chordDegree);
    }

    bus.publish('section', {
      bar,
      chordRoot: (this.rootPc + this.chordDegree) % 12,
      chordTones: this.chordPcs,
      scaleTones: this.scalePcs,
      turn,
    });

    if (this.sounds('breath')) {
      // Drones on root and fifth; a riser leans into every section turn.
      if (chordChanged || turn) {
        const dur = this.chordChangeBars * SLOTS_PER_BAR * this.slotDur;
        const dronePc = (this.rootPc + this.chordDegree) % 12;
        const droneMidi = this.intoLane(36 + dronePc, LANES.breath);
        this.emit(pending, this.swell('breath', time, 0.5, dur, 'drone', droneMidi));
        this.emit(
          pending,
          this.swell(
            'breath',
            time,
            0.35,
            dur,
            'drone',
            this.intoLane(droneMidi + 7, LANES.breath),
          ),
        );
      }
      if (barInSection === this.session.sectionBars - 1) {
        this.emit(pending, this.swell('breath', time, 0.55, SLOTS_PER_BAR * this.slotDur, 'riser'));
      }
    }

    if (bar > 0) this.evolve(bar, turn);
  }

  /**
   * The wind, precisely. On breeze, every 8 bars a continuous macro may drift a
   * small seeded step and an awake spirit may reseed. On gale, the moon may
   * shift and, rarely, the totem clicks: the valley plays itself. At every
   * section turn a minority of patterns reseed so the piece never settles. Still
   * (wind 0) freezes all of it; only section-turn reseeding remains, the slow
   * structural breath the brief asks every section to take.
   */
  private evolve(bar: number, turn: boolean): void {
    if (turn) {
      const n = this.driftRng.int(1, 2);
      for (let i = 0; i < n; i++) this.reseedPattern(this.driftRng.pick(PLAYABLE_SPIRITS));
    }
    if (this.wind >= 1 && bar % 8 === 0) {
      if (this.driftRng.chance(0.2)) this.driftMacro();
      if (this.driftRng.chance(0.1)) this.reseedPattern(this.driftRng.pick(PLAYABLE_SPIRITS));
    }
    if (this.wind >= 2 && bar % 8 === 0) {
      if (this.driftRng.chance(0.15)) {
        const step = this.driftRng.chance(0.5) ? 1 : 11;
        bus.publish('control', { target: 'moon', value: (this.rootPc + step) % 12 });
      }
      if (this.driftRng.chance(0.05)) {
        bus.publish('control', { target: 'totem', value: (this.scaleIndex + 1) % 7 });
      }
    }
  }

  /** Walk one continuous macro a small step and publish it on the control bus. */
  private driftMacro(): void {
    const id = this.driftRng.pick(PLAYABLE_SPIRITS);
    const which = this.driftRng.int(0, 2);
    const walk = this.driftRng.range(-0.15, 0.15);
    if (which === 0) {
      const v = clamp01((this.busy[id] ?? 0.5) + walk);
      bus.publish('control', { target: `busy:${id}`, value: v });
    } else if (which === 1) {
      const v = clamp01((this.timbre[id] ?? 0.5) + walk);
      this.timbre[id] = v;
      bus.publish('control', { target: `timbre:${id}`, value: v });
    } else {
      const v = Math.max(0.35, Math.min(1, this.fire + walk));
      bus.publish('control', { target: 'fire', value: v });
    }
  }

  private reseedPattern(id: SpiritId): void {
    const d = this.driftRng;
    switch (id) {
      case 'drum':
        this.kicks = rotate(euclid(d.pick([5, 7]), 16), d.int(0, 15));
        break;
      case 'root':
        this.rootCycleSlots = d.pick([3, 4, 6]) * SLOTS_PER_BEAT;
        break;
      case 'rattle':
        this.rattlePattern = rotate(euclid(d.int(4, 7), 12), d.int(0, 11));
        break;
      case 'spinner':
        this.spinnerGate = euclid(d.int(9, 13), 16);
        this.spinnerShape = d.pick(['rise', 'fall', 'pendulum', 'orbit'] as const);
        break;
      default:
        // The free voices reseed their phrasing by shifting their arc phase.
        this.arcPhase[id] = d.next();
    }
  }

  private scheduleDrum(inBar: number, bar: number, time: number, pending: NoteEvent[]): void {
    const jitter = this.rng.range(-DRUM_JITTER_S, DRUM_JITTER_S);
    if (inBar === SLOTS_PER_BEAT || inBar === SLOTS_PER_BEAT * 3) {
      this.emit(
        pending,
        this.note('drum', time + jitter, 0.7 + this.rng.range(-0.05, 0.05), 0.2, 'snare'),
      );
      return;
    }
    if (this.kicks[inBar % 16]) {
      const vel =
        inBar === 0 ? 0.95 : 0.6 + 0.25 * this.arc('drum', bar) + this.rng.range(-0.08, 0.08);
      this.emit(pending, this.note('drum', time + jitter, Math.min(1, vel), 0.3, 'kick'));
    }
    if (inBar === 14 && this.rng.chance(0.2 * this.arc('drum', bar))) {
      this.emit(pending, this.note('drum', time + jitter, 0.55, 0.25, 'tom'));
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
    this.emit(
      pending,
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
    this.emit(
      pending,
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
      (this.busy['voice'] ?? 0.5) * this.arc('voice', bar) * (strong ? 0.75 : onEighth ? 0.4 : 0.1);
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
    this.emit(
      pending,
      this.note('voice', time + jitter, Math.min(1, vel), durSlots * this.slotDur, 'lead', midi),
    );
  }

  private scheduleEcho(slot: number, inBar: number, time: number, pending: NoteEvent[]): void {
    const strong = inBar === 0 || inBar === SLOTS_PER_BEAT * 2;

    // When the Voice rests a while, the Echo turns to slow dyads on the chord.
    if (this.voiceSilentSlots > SLOTS_PER_BAR && inBar === 0) {
      const root = this.intoLane(48 + (this.chordPcs[0] ?? 0), LANES.echo);
      const dur = SLOTS_PER_BAR * this.slotDur;
      this.emit(pending, this.note('echo', time, 0.4, dur, 'dyad', root));
      this.emit(
        pending,
        this.note('echo', time, 0.32, dur, 'dyad', this.intoLane(root + 7, LANES.echo)),
      );
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
    this.emit(
      pending,
      this.note(
        'spinner',
        time + jitter,
        0.32 + 0.2 * this.arc('spinner', bar),
        this.slotDur,
        'tine',
        midi,
      ),
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
    const kept = new Set([...attacks].sort((a, b) => rank(a) - rank(b)).slice(0, cap));
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

  /**
   * Apply presence before a note reaches the bus. At full presence the note
   * passes untouched; mid-fade, rhythmic notes thin probabilistically while
   * swells simply soften, so a part dissolves musically rather than cutting.
   */
  private emit(pending: NoteEvent[], note: NoteEvent): void {
    const p = this.presence[note.spirit] ?? 1;
    if (p >= 0.999) {
      pending.push(note);
      return;
    }
    if (p <= 0.001) return;
    if (SWELLS.has(note.articulation ?? '')) {
      note.velocity *= p;
      pending.push(note);
      return;
    }
    if (this.driftRng.next() > p) return;
    note.velocity *= 0.5 + 0.5 * p;
    pending.push(note);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
