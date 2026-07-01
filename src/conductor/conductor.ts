import { bus } from '../core/bus';
import { PLAYABLE_SPIRITS } from '../core/contracts';
import type { NoteEvent, SpiritId } from '../core/contracts';
import type { Rng } from '../core/rng';
import type { Session } from '../core/session';
import { SLOTS_PER_BAR, SLOTS_PER_BEAT, secondsPerSlot } from '../core/time';
import { HarmonyChain } from './harmony';
import { euclid, rotate } from './patterns';
import { SCALES, chordTones, scaleTones } from './scales';

// The conductor owns all musical decisions; the audio engine merely renders
// them. Tale of two clocks: a 25 ms tick scans a 120 ms horizon against the
// AudioContext clock and publishes sample-stamped NoteEvents to the bus.
//
// The overhaul: music is composed a bar or a phrase at a time, not rolled
// per slot. The Voice plays motifs that repeat, vary, invert and cadence;
// the Root plays basslines in named styles; the Drum plans every bar with
// ghosts, fills and the occasional half-time breath; busyness reshapes the
// Rattle and Spinner patterns live. Every note carries a slowly drifting
// timbre so no two render identically, and every control answers with an
// immediate audible gesture.

const TICK_MS = 25;
const HORIZON_S = 0.12;
const JITTER_S = 0.008;
const DRUM_JITTER_S = 0.003;
/** Minimum gap between acknowledgement gestures per control, so drags sing rather than stutter. */
const ACK_GAP_S = 0.35;
const TWO_PI = Math.PI * 2;

/** Covenant rule 3: each spirit owns a tessitura band (midi, inclusive). */
export const LANES: Record<Exclude<SpiritId, 'world'>, readonly [number, number]> = {
  drum: [24, 48],
  rattle: [60, 84],
  root: [24, 45],
  voice: [60, 84],
  echo: [48, 72],
  spinner: [48, 84],
  breath: [36, 60],
};

/** Covenant rule 4 priority order; swells (drones, risers) are not attacks. */
const PRIORITY: readonly SpiritId[] = ['drum', 'root', 'voice', 'spinner', 'rattle', 'echo'];
const SWELLS = new Set(['drone', 'riser']);

type SpinnerShape = 'rise' | 'fall' | 'pendulum' | 'orbit';
type BassStyle = 'drone' | 'anchor' | 'pulse' | 'syncopated' | 'hemiola';
const BASS_STYLES: readonly BassStyle[] = ['drone', 'anchor', 'pulse', 'syncopated', 'hemiola'];

/** One melodic event: a scale-degree offset from the phrase anchor. */
interface MotifNote {
  slot: number;
  deg: number;
  dur: number;
  vel: number;
}

interface DrumHit {
  slot: number;
  kind: 'kick' | 'snare' | 'tom';
  vel: number;
  timbre?: number;
}

interface BassNote {
  slot: number;
  kind: 'root' | 'fifth' | 'oct' | 'approach';
  /** Scale-degree offset for approach tones walking into the next downbeat. */
  deg?: number;
  dur: number;
  vel: number;
}

export class Conductor {
  private slot = 0;
  private nextSlotTime = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private nowFn: (() => number) | undefined;
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
  /** Still 0, breeze 1, gale 2; breeze by default so the valley evolves unasked. */
  private wind = 1;
  /** The conductor's own copy of each talisman position, so drift can walk it. */
  private readonly timbre: Record<string, number> = {};
  /** Each spirit's place in the air, close and dry to far and washed. */
  private readonly space: Record<string, number> = {};
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
  /** Per-spirit timbre weather: slow seeded sines so no two notes render alike. */
  private readonly lfo: Record<string, { rate: number; phase: number; depth: number }> = {};
  /** Two spirits step forward each section; the rest recede a little. */
  private foreground = new Set<SpiritId>();
  /** Throttles acknowledgement gestures per control target. */
  private readonly lastAck = new Map<string, number>();
  /**
   * The tide: one seeded 24-48 bar sine that every spirit rides together, so
   * the valley swells and hushes collectively. Independent per-spirit arcs
   * alone average out to a flat mush; tension needs correlation.
   */
  private readonly tidePeriodBars: number;
  private readonly tidePhase: number;
  private tideNow = 0.5;
  /** At the tide's deepest trough the ensemble inhales: one bar of drone and wind. */
  private hushNow = false;
  /** The composed opening: the bar at which each spirit first enters. */
  private readonly introBar: Record<string, number> = {};
  /** The blaze: stoking the fire to full drops a held breath, then a tutti. */
  private blazeBar = -1;
  private lastBlazeBar = -99;
  /** The sky harp: strummed degrees the Voice learns to sing. */
  private readonly playerDegs: number[] = [];
  private playerDegsBar = -999;
  private lastStrumMidi: number | undefined;

  // Patterns are reseeded by the wind and at section turns, so not readonly.
  private kicks: boolean[];
  private bassStyle: BassStyle;
  private bassBar: BassNote[] = [];
  private drumBar: DrumHit[] = [];
  private rattlePattern: boolean[] = [];
  private rattleRot: number;
  private spinnerGate: boolean[] = [];
  private spinnerRot: number;
  private spinnerShape: SpinnerShape;
  private spinnerIdx = 0;
  private spinnerDir = 1;

  // The Voice's composed line: a motif, developed phrase by phrase.
  private motif: MotifNote[] = [];
  private readonly phraseEvents = new Map<number, MotifNote>();
  private phraseIndex = 0;

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

    this.kicks = rotate(euclid(rng.pick([5, 6, 7]), 16), rng.int(0, 15));
    this.bassStyle = rng.pick(BASS_STYLES);
    this.rattleRot = rng.int(0, 11);
    this.spinnerRot = rng.int(0, 15);
    this.spinnerShape = rng.pick(['rise', 'fall', 'pendulum', 'orbit'] as const);

    // The opening is composed: drone and root at the hearth, drums with a
    // pickup, melody, then the glitter, all inside the first six bars.
    const intro: Record<string, number> = {
      breath: 0,
      root: 0,
      drum: rng.pick([1, 2]),
      voice: rng.pick([2, 3]),
      rattle: rng.pick([3, 4]),
      spinner: rng.pick([4, 5]),
      echo: 5,
    };
    for (const id of [...PRIORITY, 'breath'] as SpiritId[]) {
      this.busy[id] = rng.range(0.45, 0.7);
      this.timbre[id] = rng.range(0.3, 0.7);
      this.space[id] = rng.range(0.25, 0.5);
      this.arcPhase[id] = rng.next();
      this.lfo[id] = { rate: rng.range(0.004, 0.02), phase: rng.next(), depth: rng.range(0.15, 0.3) };
      this.introBar[id] = intro[id] ?? 0;
      this.presence[id] = this.asleepNow.has(id) || (intro[id] ?? 0) > 0 ? 0 : 1;
    }
    this.tidePeriodBars = rng.int(24, 48);
    this.tidePhase = rng.next();

    this.makeMotif();
    this.foreground = new Set([
      this.driftRng.pick(PLAYABLE_SPIRITS),
      this.driftRng.pick(PLAYABLE_SPIRITS),
    ]);
  }

  start(now: () => number): void {
    if (this.timer !== undefined) return;
    this.nowFn = now;
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
   * live and answers with an immediate audible gesture, so a touch is heard
   * within a breath, not a bar. Targets follow the contracts: totem, moon,
   * censer, fire, wind, busy:<id>, timbre:<id>, wake:<id>.
   */
  handleControl(event: { target: string; value: number; y?: number }): void {
    const { target, value } = event;
    if (target === 'totem') {
      this.scaleIndex = ((Math.round(value) % 7) + 7) % 7;
      this.harmony = new HarmonyChain(this.scaleIndex, this.rng.fork(`harmony:${this.slot}`));
      this.chordDegree = 0;
      this.refreshPitches();
      this.broadcastPalette();
      // Three rising tines spell the new scale out loud.
      this.ack('totem', (t) => {
        for (let i = 0; i < 3; i++) {
          const midi = this.nearestInPool(this.scalePcs, LANES.spinner, 62 + i * 4);
          this.pub('spinner', t + i * 0.09, 0.5 + i * 0.06, 0.5, 'tine', midi);
        }
      });
      return;
    }
    if (target === 'moon') {
      this.rootPc = ((Math.round(value) % 12) + 12) % 12;
      this.refreshPitches();
      this.broadcastPalette();
      // The Root re-anchors at once: the new tonal centre is stated, not implied.
      this.ack('moon', (t) => {
        const midi = this.intoLane(24 + this.rootPc, LANES.root);
        this.pub('root', t, 0.8, 1.4, 'pluck', midi);
        this.pub('spinner', t + 0.05, 0.38, 0.6, 'tine', this.intoLane(midi + 24, LANES.spinner));
      });
      return;
    }
    if (target === 'censer') {
      this.slotDur = secondsPerSlot(value);
      // Two soft taps a new eighth-note apart: the tempo, audibly.
      this.ack('censer', (t) => {
        this.pub('drum', t, 0.4, 0.15, 'tom');
        this.pub('drum', t + this.slotDur * 2, 0.5, 0.15, 'tom');
      });
      return;
    }
    if (target === 'fire') {
      // A stoke whooshes; the slow cooling tick passes silently.
      if (value > this.fire + 0.03) {
        this.ack('fire', (t) => this.pub('breath', t, 0.4, 1.2, 'riser'));
      }
      // Stoked to a full blaze: the valley holds its breath for half a bar,
      // then drops back in together. Re-arms as the fire cools.
      if (value >= 0.97) {
        const bar = Math.floor(this.slot / SLOTS_PER_BAR);
        if (bar - this.lastBlazeBar >= 16) {
          this.blazeBar = bar + 1;
          this.lastBlazeBar = bar + 1;
        }
      }
      this.fire = value;
      this.broadcastPalette();
      return;
    }
    if (target === 'strum') {
      this.strum(value, event.y ?? 0.4);
      return;
    }
    if (target === 'wind') {
      this.wind = Math.round(value);
      this.ack('wind', (t) => this.pub('breath', t, 0.3 + 0.15 * this.wind, 0.9, 'riser'));
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
      // One note in the new colour, right now; a drag becomes a scrub you can hear.
      this.ack(target, (t) => this.gestureNote(id, t, 0.55));
    } else if (kind === 'wake') {
      const wantAwake = value >= 0.5;
      // Intent flips at once; presence ramps over two bars so the part thins
      // in or out rather than snapping. The visual transition plays off this.
      if (wantAwake) {
        this.asleepNow.delete(id);
        // A waking spirit clears its throat immediately rather than waiting
        // out the ramp: the tap is answered, then the part fades fully in.
        this.presence[id] = Math.max(this.presence[id] ?? 0, 0.4);
        this.ack(target, (t) => this.wakeSignature(id, t));
      } else {
        this.asleepNow.add(id);
      }
      bus.publish('wake', { spirit: id, awake: wantAwake });
    }
  }

  /** Run an acknowledgement gesture unless this control fired one a moment ago. */
  private ack(target: string, play: (t: number) => void): void {
    if (!this.nowFn) return;
    const now = this.nowFn();
    if (now - (this.lastAck.get(target) ?? -10) < ACK_GAP_S) return;
    this.lastAck.set(target, now);
    play(now + 0.03);
  }

  /** Publish one gesture note straight to the bus, outside the slot machinery. */
  private pub(
    spirit: SpiritId,
    time: number,
    velocity: number,
    duration: number,
    articulation: string,
    midi?: number,
  ): void {
    const e: NoteEvent = { spirit, time, velocity, duration, articulation, timbre: 0.5 };
    if (midi !== undefined) e.midi = midi;
    bus.publish('note', e);
  }

  /** A single characteristic note from one spirit, for talisman scrubbing. */
  private gestureNote(id: SpiritId, t: number, vel: number): void {
    if (id === 'drum') {
      this.pub('drum', t, vel, 0.25, 'kick');
      return;
    }
    if (id === 'world') return;
    const lane = LANES[id];
    const centre = Math.round((lane[0] + lane[1]) / 2);
    const midi = this.nearestInPool(this.chordPcs, lane, centre);
    const art =
      id === 'root' ? 'pluck'
      : id === 'voice' ? 'lead'
      : id === 'echo' ? 'bow'
      : id === 'spinner' ? 'tine'
      : id === 'rattle' ? 'hit'
      : 'drone';
    this.pub(id, t, vel, id === 'breath' ? 1.5 : 0.6, art, midi);
  }

  /**
   * The sky harp. A touch on the open sky rings a tine, always in the scale:
   * x sweeps two octaves left to right, height softens the touch. The strum
   * seeds the Echo's imitation ring (the valley answers two beats later) and
   * the Voice remembers the contour for its next phrase.
   */
  private strum(x01: number, y01: number): void {
    if (!this.nowFn) return;
    const set = SCALES[this.scaleIndex]?.set ?? [0, 2, 4, 5, 7, 9, 11];
    const n = set.length;
    const degIdx = Math.round(Math.max(0, Math.min(1, x01)) * 2 * n);
    const rootRef = 55 + ((((this.rootPc - 55) % 12) + 12) % 12);
    const midi = Math.min(88, rootRef + (set[degIdx % n] ?? 0) + 12 * Math.floor(degIdx / n));
    const vel = 0.35 + 0.4 * (1 - Math.max(0, Math.min(1, y01)));
    this.pub('spinner', this.nowFn() + 0.02, vel, 1.2, 'tine', midi);

    const interval = this.lastStrumMidi === undefined ? 0 : midi - this.lastStrumMidi;
    this.lastStrumMidi = midi;
    this.voiceNotes.set(this.slot, { midi: this.intoLane(midi, LANES.voice), interval });

    this.playerDegs.push(Math.max(-5, Math.min(7, degIdx - n)));
    if (this.playerDegs.length > 8) this.playerDegs.shift();
    this.playerDegsBar = Math.floor(this.slot / SLOTS_PER_BAR);
  }

  /** The blaze lands: everyone together on the downbeat, past the budget. */
  private tutti(time: number): void {
    const rootMidi = this.intoLane(24 + (this.chordPcs[0] ?? this.rootPc), LANES.root);
    this.pub('drum', time, 1.0, 0.35, 'kick');
    this.pub('drum', time + 0.005, 0.7, 0.3, 'tom');
    this.pub('root', time, 0.95, this.slotDur * 8, 'pluck', rootMidi);
    this.pub('rattle', time, 0.7, 0.2, 'hit', this.nearestInPool(this.chordPcs, LANES.rattle, 72));
    this.pub('spinner', time, 0.6, 0.5, 'tine', this.nearestInPool(this.chordPcs, LANES.spinner, 78));
  }

  /** The tide at a bar: 0 trough to 1 crest, seeded period and phase. */
  private tide(bar: number): number {
    return 0.5 + 0.5 * Math.sin(TWO_PI * (bar / this.tidePeriodBars + this.tidePhase));
  }

  /** A short signature figure announcing a spirit's waking. */
  private wakeSignature(id: SpiritId, t: number): void {
    switch (id) {
      case 'drum':
        this.pub('drum', t, 0.7, 0.3, 'kick');
        this.pub('drum', t + 0.14, 0.5, 0.25, 'tom');
        break;
      case 'root':
        this.pub('root', t, 0.78, 1.2, 'pluck', this.intoLane(24 + this.rootPc, LANES.root));
        break;
      case 'breath':
        this.pub('breath', t, 0.5, 2.5, 'drone', this.intoLane(36 + this.rootPc, LANES.breath));
        break;
      case 'world':
        break;
      default: {
        const lane = LANES[id];
        const m1 = this.nearestInPool(this.chordPcs, lane, Math.round((lane[0] + lane[1]) / 2));
        const m2 = this.nearestInPool(this.scalePcs, lane, m1 + 3);
        const art = id === 'voice' ? 'lead' : id === 'echo' ? 'bow' : id === 'spinner' ? 'tine' : 'hit';
        this.pub(id, t, 0.55, 0.5, art, m1);
        this.pub(id, t + 0.16, 0.6, 0.6, art, m2);
      }
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

  /** The slow timbre weather for one spirit at one moment, micro-varied per note. */
  private noteTimbre(id: SpiritId, time: number): number {
    const l = this.lfo[id];
    if (!l) return 0.5;
    const v = 0.5 + l.depth * Math.sin(TWO_PI * (l.rate * time + l.phase)) + this.rng.range(-0.06, 0.06);
    return Math.max(0, Math.min(1, v));
  }

  private scheduleSlot(slot: number, time: number): void {
    const inBar = slot % SLOTS_PER_BAR;
    const bar = Math.floor(slot / SLOTS_PER_BAR);
    const pending: NoteEvent[] = [];

    if (inBar === 0) this.onBar(bar, time, pending);

    // The blaze: half a bar of held breath, a riser, then the tutti downbeat.
    const blazing = bar === this.blazeBar;
    if (blazing && inBar < SLOTS_PER_BEAT * 2) {
      if (inBar === SLOTS_PER_BEAT) {
        this.pub('breath', time, 0.6, this.slotDur * SLOTS_PER_BEAT, 'riser');
      }
    } else {
      if (blazing && inBar === SLOTS_PER_BEAT * 2) this.tutti(time);
      // At the tide's trough the ensemble inhales: drone and root keep the
      // ground, everyone else rests the bar out.
      const hush = this.hushNow;
      if (!hush && this.sounds('drum')) this.scheduleDrum(inBar, time, pending);
      if (this.sounds('root')) this.scheduleRoot(inBar, time, pending);
      if (!hush && this.sounds('rattle')) this.scheduleRattle(slot, inBar, bar, time, pending);
      if (!hush && this.sounds('voice')) this.scheduleVoice(slot, inBar, bar, time, pending);
      if (!hush && this.sounds('echo')) this.scheduleEcho(slot, inBar, time, pending);
      if (!hush && this.sounds('spinner')) this.scheduleSpinner(slot, bar, time, pending);
    }

    this.voiceNotes.delete(slot - SLOTS_PER_BAR * 2);
    this.phraseEvents.delete(slot - SLOTS_PER_BAR * 2);

    for (const event of this.enforceBudget(pending)) {
      bus.publish('note', event);
    }
  }

  private onBar(bar: number, time: number, pending: NoteEvent[]): void {
    const barInSection = bar % this.session.sectionBars;
    const turn = barInSection === 0;

    // Presence eases toward intent over two bars (covenant rule 7); before a
    // spirit's intro bar its intent is silence, so the opening is composed.
    for (const id of PLAYABLE_SPIRITS) {
      const target = this.asleepNow.has(id) || bar < (this.introBar[id] ?? 0) ? 0 : 1;
      const cur = this.presence[id] ?? 0;
      this.presence[id] = cur + Math.max(-0.5, Math.min(0.5, target - cur));
    }

    // The tide everyone rides; the hush waits until the piece has settled.
    this.tideNow = this.tide(bar);
    this.hushNow = bar >= 12 && this.tideNow < 0.06;

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

    // Compose the coming bar: drums, bass, and the phased percussion patterns.
    this.planDrumBar(bar);
    this.planBassBar();
    if (bar % 4 === 0) this.rattleRot = (this.rattleRot + this.rng.int(0, 3)) % 12;
    this.rattlePattern = rotate(euclid(3 + Math.round((this.busy['rattle'] ?? 0.5) * 5), 12), this.rattleRot);
    this.spinnerGate = rotate(euclid(7 + Math.round((this.busy['spinner'] ?? 0.5) * 6), 16), this.spinnerRot);
    if (bar % 2 === 0) this.planVoicePhrase(bar);

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
   * The wind, precisely. On breeze (the default), every 4 bars a continuous
   * macro may drift a small seeded step and a pattern may reseed. On gale, the
   * moon may shift and, rarely, the totem clicks: the valley plays itself. At
   * every section turn patterns reseed and the foreground pair rotates, so the
   * piece never settles. Still (wind 0) freezes all of it; only section-turn
   * reseeding remains, the slow structural breath every section takes.
   */
  private evolve(bar: number, turn: boolean): void {
    if (turn) {
      const n = this.driftRng.int(2, 3);
      for (let i = 0; i < n; i++) this.reseedPattern(this.driftRng.pick(PLAYABLE_SPIRITS));
      const a = this.driftRng.pick(PLAYABLE_SPIRITS);
      let b = this.driftRng.pick(PLAYABLE_SPIRITS);
      if (b === a) b = this.driftRng.pick(PLAYABLE_SPIRITS);
      this.foreground = new Set([a, b]);
    }
    if (this.wind >= 1 && bar % 4 === 0) {
      if (this.driftRng.chance(0.3)) this.driftMacro();
      if (this.driftRng.chance(0.12)) this.reseedPattern(this.driftRng.pick(PLAYABLE_SPIRITS));
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
    const which = this.driftRng.int(0, 3);
    const walk = this.driftRng.range(-0.15, 0.15);
    if (which === 0) {
      const v = clamp01((this.busy[id] ?? 0.5) + walk);
      bus.publish('control', { target: `busy:${id}`, value: v });
    } else if (which === 1) {
      const v = clamp01((this.timbre[id] ?? 0.5) + walk);
      this.timbre[id] = v;
      bus.publish('control', { target: `timbre:${id}`, value: v });
    } else if (which === 2) {
      // A spirit drifts nearer the fire or further into the mist.
      const v = clamp01((this.space[id] ?? 0.35) + walk);
      this.space[id] = v;
      bus.publish('control', { target: `space:${id}`, value: v });
    } else {
      const v = Math.max(0.35, Math.min(1, this.fire + walk));
      bus.publish('control', { target: 'fire', value: v });
    }
  }

  private reseedPattern(id: SpiritId): void {
    const d = this.driftRng;
    switch (id) {
      case 'drum':
        this.kicks = rotate(euclid(d.pick([5, 6, 7]), 16), d.int(0, 15));
        break;
      case 'root':
        this.bassStyle = d.pick(BASS_STYLES);
        break;
      case 'voice':
        this.makeMotif();
        break;
      case 'rattle':
        this.rattleRot = d.int(0, 11);
        break;
      case 'spinner':
        this.spinnerRot = d.int(0, 15);
        this.spinnerShape = d.pick(['rise', 'fall', 'pendulum', 'orbit'] as const);
        break;
      default:
        // The free voices reseed their phrasing by shifting their arc phase.
        this.arcPhase[id] = d.next();
    }
  }

  // --- the Voice: a motif, developed ---

  /**
   * Compose a one-bar motif: 4 to 7 onsets drawn toward the musical slots, a
   * contour that steps mostly and resolves its leaps, durations that fill the
   * gaps. The motif persists across phrases; development, not dice, makes the
   * line.
   */
  private makeMotif(): void {
    const r = this.rng;
    const count = r.int(4, 7);
    const weights = [6, 1, 2, 2, 4, 1, 3, 2, 5, 1, 2, 2, 3, 2, 3, 1];
    const avail = weights.map((w, i) => ({ w, i }));
    const slots: number[] = [];
    while (slots.length < count && avail.length > 0) {
      const total = avail.reduce((a, b) => a + b.w, 0);
      let t = r.next() * total;
      let k = 0;
      for (; k < avail.length - 1; k++) {
        t -= avail[k]!.w;
        if (t <= 0) break;
      }
      slots.push(avail[k]!.i);
      avail.splice(k, 1);
    }
    slots.sort((a, b) => a - b);
    if (!slots.includes(0) && !slots.includes(8)) slots[0] = 0;

    let deg = 0;
    let lastStep = 0;
    const notes: MotifNote[] = [];
    for (let i = 0; i < slots.length; i++) {
      if (i > 0) {
        let step: number;
        if (Math.abs(lastStep) >= 3) {
          // A leap resolves by step in the opposite direction: melodic grammar.
          step = -Math.sign(lastStep) * r.int(1, 2);
        } else if (r.chance(0.18)) {
          step = r.pick([3, 4, -3, -4]);
        } else {
          step = r.pick([-2, -1, -1, 1, 1, 2]);
        }
        deg = Math.max(-5, Math.min(7, deg + step));
        lastStep = step;
      }
      const s = slots[i]!;
      const next = slots[i + 1] ?? 16;
      const dur = i === slots.length - 1 ? r.int(2, 6) : Math.max(1, Math.min(4, next - s));
      const vel = (s % 8 === 0 ? 0.82 : s % 4 === 0 ? 0.7 : 0.56) + r.range(-0.05, 0.05);
      notes.push({ slot: s, deg, dur, vel });
    }
    this.motif = notes;
  }

  /**
   * Realise the next two bars of melody from the motif. Phrases cycle through
   * statement, varied repeat, fragment, and inverted answer with a cadence;
   * the second bar continues, cadences, or rests. Busyness composes ornament
   * and thinning at plan time rather than rolling dice per note.
   */
  private planVoicePhrase(bar: number): void {
    const r = this.rng;
    const p = this.phraseIndex % 4;
    this.phraseIndex += 1;
    const busy = this.busy['voice'] ?? 0.5;
    const anchor = Math.round((this.arc('voice', bar) - 0.5) * 5);

    let evs = this.motif.map((m) => ({ ...m }));
    // The valley hums what you strummed: for a while after a sky-harp phrase,
    // the player's contour rides the motif's rhythm, and the phrase transforms
    // below develop it like any other theme.
    if (this.playerDegs.length >= 3 && bar - this.playerDegsBar <= 8) {
      evs = evs.map((e, i) => ({ ...e, deg: this.playerDegs[i % this.playerDegs.length] ?? e.deg }));
    }
    if (p === 1) {
      const t = r.pick([-2, -1, 1, 2]);
      for (const e of evs) e.deg += t;
    } else if (p === 2) {
      evs = evs.slice(0, Math.ceil(evs.length / 2));
    } else if (p === 3) {
      for (const e of evs) e.deg = -e.deg;
      const last = evs[evs.length - 1];
      if (last) {
        last.deg = 0;
        last.dur = r.int(4, 8);
        last.vel = 0.72;
      }
    }

    if (busy > 0.55) {
      const extra: MotifNote[] = [];
      for (let i = 0; i + 1 < evs.length; i++) {
        const a = evs[i]!;
        const b = evs[i + 1]!;
        if (b.slot - a.slot >= 2 && Math.abs(b.deg - a.deg) >= 2 && r.chance((busy - 0.55) * 1.6)) {
          extra.push({ slot: b.slot - 1, deg: Math.round((a.deg + b.deg) / 2), dur: 1, vel: 0.42 });
          a.dur = Math.min(a.dur, Math.max(1, b.slot - 1 - a.slot));
        }
      }
      evs.push(...extra);
      evs.sort((x, y) => x.slot - y.slot);
    } else if (busy < 0.35) {
      evs = evs.filter((e, i) => i === 0 || e.vel > 0.6 || r.chance(busy * 2));
    }

    const base = bar * SLOTS_PER_BAR;
    for (const e of evs) this.phraseEvents.set(base + e.slot, { ...e, deg: e.deg + anchor });

    const base2 = base + SLOTS_PER_BAR;
    if (p === 0) {
      // Continuation: the motif's tail answers itself a bar later, a step down.
      for (const e of this.motif.filter((m) => m.slot >= 8)) {
        this.phraseEvents.set(base2 + e.slot - 8, {
          ...e,
          slot: e.slot - 8,
          deg: e.deg + anchor - 1,
          vel: e.vel * 0.9,
        });
      }
    } else if (p === 1) {
      // Cadence: a long settling note on the downbeat.
      this.phraseEvents.set(base2, { slot: 0, deg: anchor, dur: r.int(4, 8), vel: 0.7 });
    }
    // Phrases 2 and 3 leave their second bar silent: the line breathes.
  }

  private scheduleVoice(
    slot: number,
    inBar: number,
    bar: number,
    time: number,
    pending: NoteEvent[],
  ): void {
    const ev = this.phraseEvents.get(slot);
    if (!ev) {
      this.voiceSilentSlots += 1;
      return;
    }
    this.voiceSilentSlots = 0;

    // Covenant rule 2: chord tones on strong beats, scale tones elsewhere. The
    // degree realises against the live scale, so a totem or moon change mid-
    // phrase retunes the melody rather than restarting it.
    const strong = inBar === 0 || inBar === SLOTS_PER_BEAT * 2;
    let midi = this.midiOfDegree(ev.deg, LANES.voice);
    midi = this.nearestInPool(strong ? this.chordPcs : this.scalePcs, LANES.voice, midi);
    const interval = this.lastVoiceMidi === undefined ? 0 : midi - this.lastVoiceMidi;
    this.lastVoiceMidi = midi;
    this.voiceNotes.set(slot, { midi, interval });

    const vel = Math.min(1, ev.vel * (0.72 + 0.42 * this.arc('voice', bar)));
    const jitter = this.rng.range(-JITTER_S, JITTER_S);
    this.emit(
      pending,
      this.note('voice', time + jitter, vel, ev.dur * this.slotDur * 0.95, 'lead', midi),
    );
  }

  // --- the Root: basslines in styles ---

  private planBassBar(): void {
    const r = this.rng;
    const busy = this.busy['root'] ?? 0.5;
    let plan: BassNote[];
    switch (this.bassStyle) {
      case 'drone':
        plan = [{ slot: 0, kind: 'root', dur: 14, vel: 0.8 }];
        break;
      case 'anchor':
        plan = [
          { slot: 0, kind: 'root', dur: 6, vel: 0.8 },
          { slot: 8, kind: 'fifth', dur: 4, vel: 0.62 },
          { slot: 12, kind: 'root', dur: 3, vel: 0.58 },
        ];
        break;
      case 'pulse':
        plan = [
          { slot: 0, kind: 'root', dur: 3, vel: 0.8 },
          { slot: 4, kind: 'root', dur: 3, vel: 0.55 },
          { slot: 8, kind: 'fifth', dur: 3, vel: 0.68 },
          { slot: 12, kind: 'fifth', dur: 2, vel: 0.55 },
          { slot: 14, kind: 'oct', dur: 2, vel: 0.5 },
        ];
        break;
      case 'syncopated':
        plan = [
          { slot: 0, kind: 'root', dur: 2, vel: 0.82 },
          { slot: 3, kind: 'fifth', dur: 2, vel: 0.52 },
          { slot: 6, kind: 'root', dur: 3, vel: 0.66 },
          { slot: 10, kind: 'oct', dur: 2, vel: 0.6 },
          { slot: 14, kind: 'fifth', dur: 2, vel: 0.5 },
        ];
        break;
      case 'hemiola':
        plan = [
          { slot: 0, kind: 'root', dur: 5, vel: 0.78 },
          { slot: 6, kind: 'fifth', dur: 5, vel: 0.64 },
          { slot: 12, kind: 'root', dur: 5, vel: 0.7 },
        ];
        break;
    }
    if (busy < 0.4) plan = plan.filter((e) => e.slot === 0 || e.vel > 0.6);
    if (busy > 0.7 && this.bassStyle !== 'drone' && r.chance(0.4)) {
      plan.push({ slot: 15, kind: 'oct', dur: 1, vel: 0.48 });
    }
    // A scalewise walk into the next downbeat, now and then.
    if (this.bassStyle !== 'drone' && r.chance(0.25)) {
      plan = plan.filter((e) => e.slot < 14);
      plan.push({ slot: 14, kind: 'approach', deg: -2, dur: 1, vel: 0.5 });
      plan.push({ slot: 15, kind: 'approach', deg: -1, dur: 1, vel: 0.56 });
    }
    this.bassBar = plan;
  }

  private scheduleRoot(inBar: number, time: number, pending: NoteEvent[]): void {
    for (const e of this.bassBar) {
      if (e.slot !== inBar) continue;
      let midi: number;
      if (e.kind === 'approach') {
        midi = this.midiOfDegree(e.deg ?? -1, LANES.root);
      } else {
        // Voiced from the sounding chord's own tones, so the bass follows the
        // harmony wherever the Markov chain walks it.
        const rootPc = this.chordPcs[0] ?? this.rootPc;
        const fifthPc = this.chordPcs[this.chordPcs.length - 1] ?? rootPc;
        const rootMidi = this.intoLane(24 + rootPc, LANES.root);
        midi =
          e.kind === 'root' ? rootMidi
          : e.kind === 'fifth' ? this.intoLane(rootMidi + ((fifthPc - rootPc + 12) % 12), LANES.root)
          : Math.min(LANES.root[1], rootMidi + 12);
      }
      const jitter = this.rng.range(-JITTER_S, JITTER_S);
      this.emit(
        pending,
        this.note(
          'root',
          time + jitter,
          Math.min(1, e.vel + this.rng.range(-0.05, 0.05)),
          e.dur * this.slotDur * 0.9,
          'pluck',
          midi,
        ),
      );
    }
  }

  // --- the Drum: a bar composed at a time ---

  /**
   * Plan the whole bar: the Euclidean kick skeleton with occasional drops,
   * ghost kicks and ghost snares scaled by busyness and fire, a lazy or
   * half-time backbeat now and then, and fills at group and section ends.
   */
  private planDrumBar(bar: number): void {
    const r = this.rng;
    const busy = this.busy['drum'] ?? 0.5;
    const f = this.fire;
    const arc = this.arc('drum', bar);
    const hits: DrumHit[] = [];

    const sectionEnd = bar % this.session.sectionBars === this.session.sectionBars - 1;
    const groupEnd = bar % 4 === 3;
    const fill = sectionEnd ? r.chance(0.75) : groupEnd && r.chance(0.4 * (0.5 + busy));
    const fillStart = sectionEnd ? 10 : 12;
    const halfTime = !fill && r.chance(0.07);

    for (let s = 0; s < SLOTS_PER_BAR; s++) {
      if (fill && s >= fillStart) continue;
      if (!this.kicks[s]) continue;
      if (s !== 0 && r.chance(0.08)) continue;
      const vel = s === 0 ? 0.95 : 0.6 + 0.25 * arc + r.range(-0.08, 0.08);
      hits.push({ slot: s, kind: 'kick', vel: Math.min(1, vel) });
    }
    for (const s of [3, 6, 10, 14]) {
      if (fill && s >= fillStart) continue;
      if (!this.kicks[s] && r.chance(0.22 * busy * f * (0.5 + this.tideNow))) {
        hits.push({ slot: s, kind: 'kick', vel: r.range(0.26, 0.36) });
      }
    }

    if (halfTime) {
      hits.push({ slot: SLOTS_PER_BEAT * 2, kind: 'snare', vel: 0.74 });
    } else {
      for (const s of [SLOTS_PER_BEAT, SLOTS_PER_BEAT * 3]) {
        if (fill && s >= fillStart) continue;
        const lazy = r.chance(0.05) ? 1 : 0;
        hits.push({ slot: s + lazy, kind: 'snare', vel: 0.66 + r.range(-0.05, 0.05) });
      }
    }
    for (const s of [2, 7, 11, 15]) {
      if (fill && s >= fillStart) continue;
      if (r.chance(0.22 * busy * (0.5 + this.tideNow))) {
        hits.push({ slot: s, kind: 'snare', vel: r.range(0.14, 0.26) });
      }
    }
    if (!fill && r.chance(0.15 * busy)) {
      hits.push({ slot: r.pick([6, 10, 14]), kind: 'tom', vel: 0.5 });
    }

    if (fill) {
      const kind = r.pick(['run', 'fall', 'ruff'] as const);
      if (kind === 'run') {
        for (let s = fillStart; s < SLOTS_PER_BAR; s++) {
          hits.push({
            slot: s,
            kind: 'snare',
            vel: 0.3 + ((s - fillStart) / (SLOTS_PER_BAR - fillStart)) * 0.5,
          });
        }
      } else if (kind === 'fall') {
        // Toms falling in pitch via the per-note timbre field.
        let t = 0.85;
        for (const s of sectionEnd ? [10, 12, 14, 15] : [12, 14, 15]) {
          hits.push({ slot: s, kind: 'tom', vel: 0.45 + t * 0.3, timbre: t });
          t -= 0.22;
        }
      } else {
        hits.push({ slot: 13, kind: 'snare', vel: 0.34 });
        hits.push({ slot: 14, kind: 'snare', vel: 0.44 });
        hits.push({ slot: 15, kind: 'snare', vel: 0.8 });
      }
    }

    // The fire is the master intensity, the tide the collective breath.
    const scale = (0.72 + 0.28 * f) * (0.85 + 0.25 * this.tideNow);
    for (const h of hits) h.vel = Math.min(1, h.vel * scale);
    this.drumBar = hits;
  }

  private scheduleDrum(inBar: number, time: number, pending: NoteEvent[]): void {
    for (const h of this.drumBar) {
      if (h.slot !== inBar) continue;
      const jitter = this.rng.range(-DRUM_JITTER_S, DRUM_JITTER_S);
      const n = this.note('drum', time + jitter, h.vel, 0.25, h.kind);
      if (h.timbre !== undefined) n.timbre = h.timbre;
      this.emit(pending, n);
    }
  }

  // --- the phased percussion ---

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
    const p =
      (0.4 + 0.6 * (this.busy['rattle'] ?? 0.5) * this.arc('rattle', bar)) *
      (0.55 + 0.7 * this.tideNow);
    if (!this.rng.chance(Math.min(1, p))) return;
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
    this.emit(
      pending,
      this.note('echo', time + jitter, 0.45, this.slotDur * this.rng.pick([2, 3, 4]), 'bow', midi),
    );
  }

  private scheduleSpinner(slot: number, bar: number, time: number, pending: NoteEvent[]): void {
    if (!this.spinnerGate[slot % 16]) return;
    const p =
      (0.45 + 0.55 * (this.busy['spinner'] ?? 0.5) * this.arc('spinner', bar)) *
      (0.55 + 0.7 * this.tideNow);
    if (!this.rng.chance(Math.min(1, p))) return;
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
   * Covenant rule 4, loosened for the full ensemble: at most 4 attacks per
   * slot, stretching to 5 when the Drum + Root pairing lands together. Swells
   * never count. Lower priority drops first.
   */
  private enforceBudget(pending: NoteEvent[]): NoteEvent[] {
    const attacks = pending.filter((e) => !SWELLS.has(e.articulation ?? ''));
    const hasDrum = attacks.some((e) => e.spirit === 'drum');
    const hasRoot = attacks.some((e) => e.spirit === 'root');
    const cap = hasDrum && hasRoot ? 5 : 4;
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

  /** Realise a scale degree (0 = the root) as a midi note inside a lane. */
  private midiOfDegree(deg: number, lane: readonly [number, number]): number {
    const set = SCALES[this.scaleIndex]?.set ?? [0, 2, 4, 5, 7, 9, 11];
    const n = set.length;
    const idx = ((deg % n) + n) % n;
    const oct = Math.floor(deg / n);
    const rootRef = lane[0] + ((((this.rootPc - lane[0]) % 12) + 12) % 12);
    return this.intoLane(rootRef + (set[idx] as number) + 12 * oct, lane);
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
   * Apply the foreground lift, the timbre weather, and presence before a note
   * reaches the bus. At full presence the note passes untouched; mid-fade,
   * rhythmic notes thin probabilistically while swells simply soften, so a
   * part dissolves musically rather than cutting.
   */
  private emit(pending: NoteEvent[], note: NoteEvent): void {
    if (this.foreground.has(note.spirit)) {
      note.velocity = Math.min(1, note.velocity * 1.12);
    }
    if (note.timbre === undefined) {
      note.timbre = this.noteTimbre(note.spirit, note.time);
    }
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
