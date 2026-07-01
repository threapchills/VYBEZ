// Vybez Core: one worklet hosts all voices, message-driven, consuming a
// sample-stamped event queue. Phase 2 brings the full family: wavetable lead
// with breath and vibrato, modal banks for rattle and spinner, shaker grains,
// a bowed string for the echo, a waveguide pipe with risers for the breath,
// over the phase 1 Karplus root and modal drum kit. Events land at sample
// offsets inside the render quantum; voices pool, steal with fades, declick
// on restart, and carry seeded per-note micro-variation throughout.

interface NoteMessage {
  type: 'note';
  spirit: string;
  when: number;
  midi?: number;
  velocity: number;
  duration: number;
  articulation?: string;
  /** Per-note timbre 0 to 1, 0.5 neutral: a deviation around the patch. */
  timbre?: number;
}

/** Send levels every patch carries: shimmer cavern, near room, delay bank. */
interface Sends {
  revA: number;
  revB: number;
  dly: number;
}

interface RootPatch extends Sends {
  brightness: number;
  subMix: number;
  pan: number;
  gain: number;
  detuneCents: number;
}

interface DrumPatch extends Sends {
  tone: number;
  decay: number;
  pan: number;
  gain: number;
}

interface ModalPatch extends Sends {
  ratios: number[];
  gains: number[];
  t60s: number[];
  hardness: number;
  position: number;
  dampTilt: number;
  /** Gamelan paired tuning: a second detuned bank beats against the first. */
  pair: number;
  pan: number;
  gain: number;
}

interface ShakerPatch extends Sends {
  centreHz: number;
  decay: number;
  gain: number;
}

interface BowedPatch extends Sends {
  brightness: number;
  pressure: number;
  trem: number;
  tremRate: number;
  pan: number;
  gain: number;
  detuneCents: number;
}

interface PipePatch extends Sends {
  cutoff: number;
  chiff: number;
  trem: number;
  tremRate: number;
  pan: number;
  gain: number;
}

interface WavetablePatch extends Sends {
  morph: number;
  breath: number;
  vibratoCents: number;
  vibratoRate: number;
  attack: number;
  release: number;
  glide: number;
  trem: number;
  tremRate: number;
  unison: number;
  pan: number;
  gain: number;
  detuneCents: number;
}

interface TablesPayload {
  data: Float32Array;
  tableCount: number;
  mipCount: number;
  size: number;
}

interface PatchesMessage {
  type: 'patches';
  seed: number;
  root: RootPatch;
  drum: DrumPatch;
  rattle: ModalPatch;
  shaker: ShakerPatch;
  spinner: ModalPatch;
  voice: WavetablePatch;
  echo: BowedPatch;
  breath: PipePatch;
  tables: TablesPayload;
}

interface PatchUpdateMessage {
  type: 'patch-update';
  key: 'root' | 'drum' | 'rattle' | 'shaker' | 'spinner' | 'voice' | 'echo' | 'breath';
  patch: Record<string, number>;
}

interface WorldMessage {
  type: 'world';
  wind: number;
}

/** Fire intimacy: a high fire pulls the valley close and dry. */
interface SpaceMessage {
  type: 'space';
  fire: number;
}

/** A sky strum opens the space for a while; pulses accumulate and decay. */
interface GlowMessage {
  type: 'glow';
}

/** A moon change: the lead glides into the new key for a few seconds. */
interface GlideMessage {
  type: 'glide';
}

type InMessage =
  | NoteMessage
  | PatchesMessage
  | PatchUpdateMessage
  | WorldMessage
  | SpaceMessage
  | GlowMessage
  | GlideMessage;

interface QueuedNote extends NoteMessage {
  startFrame: number;
}

const STEAL_FADE_S = 0.005;
const TWO_PI = Math.PI * 2;
/** Partial caps per mip; mirrors tables.ts. */
const MIP_CAPS = [64, 20, 7, 3];

function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function centsRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Shift a patch parameter by the note's timbre deviation, 0.5 neutral. */
function tshift(base: number, tim: number, span: number): number {
  return clamp01(base + (tim - 0.5) * span);
}

/** Tiny deterministic stream for per-note micro-variation. */
class WorkletRng {
  constructor(private state: number) {}
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
}

abstract class Voice {
  active = false;
  age = 0;
  protected fade = 1;
  protected fadeStep = 0;
  protected attackFrames = 1;
  protected panL = 1;
  protected panR = 1;

  protected setPan(pan: number): void {
    const p = Math.max(-1, Math.min(1, pan));
    this.panL = Math.cos(((p + 1) / 2) * (Math.PI / 2));
    this.panR = Math.sin(((p + 1) / 2) * (Math.PI / 2));
  }

  protected begin(attackSeconds: number): void {
    this.age = 0;
    this.fade = 1;
    this.fadeStep = 0;
    this.attackFrames = Math.max(1, Math.round(attackSeconds * sampleRate));
    this.active = true;
  }

  protected attack(): number {
    return this.age < this.attackFrames ? this.age / this.attackFrames : 1;
  }

  steal(): void {
    this.fadeStep = -1 / (STEAL_FADE_S * sampleRate);
  }

  protected stepFade(): number {
    if (this.fadeStep !== 0) {
      this.fade += this.fadeStep;
      if (this.fade <= 0) {
        this.fade = 0;
        this.active = false;
      }
    }
    return this.fade;
  }

  protected mix(l: Float32Array, r: Float32Array, i: number, s: number): void {
    l[i] = l[i]! + s * this.panL;
    r[i] = r[i]! + s * this.panR;
  }

  abstract render(l: Float32Array, r: Float32Array, from: number, to: number): void;
}

class StringVoice extends Voice {
  private buf = new Float32Array(4096);
  private len = 1;
  private pos = 0;
  private lp = 0;
  private loopGain = 0.996;
  private damp = 0.4;
  private gateFrames = 0;
  private subPhase = 0;
  private subInc = 0;
  private subLevel = 0;
  private subDecay = 1;
  private gain = 1;

  start(
    freq: number,
    velocity: number,
    durFrames: number,
    patch: RootPatch,
    rng: WorkletRng,
    tim = 0.5,
  ): void {
    const f = freq * centsRatio(patch.detuneCents + rng.range(-2, 2));
    const brightness = tshift(patch.brightness, tim, 0.5);
    this.len = Math.max(2, Math.min(this.buf.length, Math.round(sampleRate / f)));
    this.pos = 0;
    this.lp = 0;
    this.loopGain = 0.995 + 0.004 * Math.min(1, durFrames / sampleRate);
    this.damp = 0.25 + brightness * 0.55;
    this.gateFrames = durFrames;
    this.gain = patch.gain * velocity;
    this.setPan(patch.pan);

    const cutoff = 0.15 + brightness * 0.75 * velocity;
    let filt = 0;
    for (let i = 0; i < this.len; i++) {
      filt += cutoff * (rng.range(-1, 1) - filt);
      this.buf[i] = filt;
    }
    const pick = Math.floor(this.len * 0.27);
    for (let i = this.len - 1; i >= pick; i--) {
      this.buf[i] = this.buf[i]! - 0.5 * this.buf[i - pick]!;
    }

    this.subPhase = 0;
    this.subInc = f / 2 / sampleRate;
    this.subLevel = patch.subMix * velocity;
    this.subDecay = Math.exp(-1 / Math.max(1, durFrames * 0.9));
    this.begin(0.0015);
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    const buf = this.buf;
    for (let i = from; i < to; i++) {
      const out = buf[this.pos]!;
      this.lp += this.damp * (out - this.lp);
      buf[this.pos] = this.lp * this.loopGain;
      this.pos = (this.pos + 1) % this.len;

      this.subPhase += this.subInc;
      if (this.subPhase >= 1) this.subPhase -= 1;
      const sub = Math.sin(TWO_PI * this.subPhase) * this.subLevel;
      this.subLevel *= this.subDecay;

      this.age += 1;
      if (this.age === this.gateFrames) this.loopGain *= 0.985;
      this.mix(l, r, i, (out + sub) * this.gain * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (Math.abs(this.lp) < 1e-24) this.lp = 0;
    if (this.age > this.gateFrames + sampleRate * 3) this.active = false;
  }
}

class DrumVoice extends Voice {
  private kind: 'kick' | 'snare' | 'tom' = 'kick';
  private phase = 0;
  private phase2 = 0;
  private freq = 50;
  private freqEnd = 42;
  private freqTau = 1;
  private ampTau = 1;
  private noiseTau = 1;
  private noiseLevel = 0;
  private svfLow = 0;
  private svfBand = 0;
  private svfF = 0.2;
  private gain = 1;
  private rng!: WorkletRng;

  start(
    kind: 'kick' | 'snare' | 'tom',
    velocity: number,
    patch: DrumPatch,
    rng: WorkletRng,
    tim = 0.5,
  ): void {
    this.kind = kind;
    this.rng = rng;
    this.phase = 0;
    this.phase2 = 0;
    this.svfLow = 0;
    this.svfBand = 0;
    const tone = tshift(patch.tone, tim, 0.6);
    const decay = 0.6 + tshift(patch.decay, tim, 0.3) * 0.8;
    const hard = 0.7 + velocity * 0.6;

    if (kind === 'kick') {
      this.freq = (88 + tone * 40) * hard * rng.range(0.97, 1.03);
      this.freqEnd = 42;
      this.freqTau = 0.03 * sampleRate;
      this.ampTau = 0.16 * decay * sampleRate;
      this.noiseLevel = 0.4 * velocity;
      this.noiseTau = 0.004 * sampleRate;
    } else if (kind === 'snare') {
      this.freq = 186 * rng.range(0.97, 1.03);
      this.freqEnd = this.freq * 0.92;
      this.freqTau = 0.02 * sampleRate;
      this.ampTau = 0.07 * decay * sampleRate;
      this.noiseLevel = (0.5 + tone * 0.4) * velocity;
      this.noiseTau = 0.11 * decay * sampleRate;
      this.svfF = 2 * Math.sin((Math.PI * (1400 + tone * 1200)) / sampleRate);
    } else {
      this.freq = (96 + tone * 50) * rng.range(0.96, 1.04);
      this.freqEnd = this.freq * 0.82;
      this.freqTau = 0.08 * sampleRate;
      this.ampTau = 0.22 * decay * sampleRate;
      this.noiseLevel = 0.12 * velocity;
      this.noiseTau = 0.02 * sampleRate;
    }
    this.gain = patch.gain * velocity;
    this.setPan(patch.pan + (kind === 'tom' ? 0.15 : 0));
    this.begin(0.0005);
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const t = this.age;
      const f = this.freqEnd + (this.freq - this.freqEnd) * Math.exp(-t / this.freqTau);
      this.phase += f / sampleRate;
      const ampEnv = Math.exp(-t / this.ampTau);
      let s = Math.sin(TWO_PI * this.phase) * ampEnv;

      if (this.kind === 'snare') {
        this.phase2 += (f * 1.78) / sampleRate;
        s = s * 0.7 + Math.sin(TWO_PI * this.phase2) * ampEnv * 0.3;
      } else if (this.kind === 'tom') {
        this.phase2 += (f * 1.59) / sampleRate;
        s = s * 0.75 + Math.sin(TWO_PI * this.phase2) * ampEnv * 0.25;
      }

      const noiseEnv = Math.exp(-t / this.noiseTau) * this.noiseLevel;
      if (noiseEnv > 1e-5) {
        let n = this.rng.range(-1, 1);
        if (this.kind === 'snare') {
          this.svfLow += this.svfF * this.svfBand;
          const high = n - this.svfLow - 0.6 * this.svfBand;
          this.svfBand += this.svfF * high;
          n = this.svfBand;
        }
        s += n * noiseEnv;
      }

      this.age += 1;
      this.mix(l, r, i, s * this.gain * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (this.age > this.ampTau * 8 + this.noiseTau * 8) this.active = false;
  }
}

/** A bank of two-pole resonators: bells, woodblocks, tines. */
class ModalVoice extends Voice {
  private static readonly MAX_MODES = 12;
  private c1 = new Float32Array(ModalVoice.MAX_MODES);
  private r2 = new Float32Array(ModalVoice.MAX_MODES);
  private g = new Float32Array(ModalVoice.MAX_MODES);
  private y1 = new Float32Array(ModalVoice.MAX_MODES);
  private y2 = new Float32Array(ModalVoice.MAX_MODES);
  private modeCount = 0;
  private exciteFrames = 0;
  private exciteLevel = 0;
  private tailFrames = 1;
  private gain = 1;
  private rng!: WorkletRng;

  start(freq: number, velocity: number, patch: ModalPatch, rng: WorkletRng, tim = 0.5): void {
    this.rng = rng;
    this.modeCount = 0;
    let longestT60 = 0.1;
    const nyq = sampleRate * 0.45;
    const position = Math.max(0.02, Math.min(0.95, patch.position + (tim - 0.5) * 0.3));
    const dampTilt = Math.max(0.4, Math.min(0.99, patch.dampTilt - (tim - 0.5) * 0.2));
    for (let m = 0; m < Math.min(patch.ratios.length, ModalVoice.MAX_MODES); m++) {
      // Seeded modal jitter within material tolerances.
      const f = freq * (patch.ratios[m] ?? 1) * rng.range(0.996, 1.004);
      if (f >= nyq) continue;
      const i = this.modeCount++;
      // Damping tilt: high modes die faster.
      const t60 = (patch.t60s[m] ?? 0.5) * Math.pow(dampTilt, m);
      longestT60 = Math.max(longestT60, t60);
      const radius = Math.pow(10, -3 / (t60 * sampleRate));
      const theta = (TWO_PI * f) / sampleRate;
      this.c1[i] = 2 * radius * Math.cos(theta);
      this.r2[i] = radius * radius;
      // Strike position combs the mode gains.
      const comb = Math.abs(Math.sin(Math.PI * position * (m + 1)));
      this.g[i] = (patch.gains[m] ?? 0.5) * (0.25 + 0.75 * comb);
      this.y1[i] = 0;
      this.y2[i] = 0;
    }
    // Gamelan paired tuning: a twin bank a shade sharp beats slowly against
    // the first, the ombak shimmer of paired instruments. This is the modal
    // synth's chorus, and it is period-correct.
    const pair = Math.max(0, Math.min(1, patch.pair ?? 0)) * (0.7 + (tim - 0.5) * 0.6);
    if (pair > 0.05) {
      const baseCount = this.modeCount;
      const detune = 1.0008 + pair * 0.0025;
      for (let m = 0; m < baseCount && this.modeCount < ModalVoice.MAX_MODES; m++) {
        const f = freq * (patch.ratios[m] ?? 1) * detune;
        if (f >= nyq) continue;
        const i = this.modeCount++;
        const t60 = (patch.t60s[m] ?? 0.5) * Math.pow(dampTilt, m) * 0.9;
        const radius = Math.pow(10, -3 / (t60 * sampleRate));
        const theta = (TWO_PI * f) / sampleRate;
        this.c1[i] = 2 * radius * Math.cos(theta);
        this.r2[i] = radius * radius;
        const comb = Math.abs(Math.sin(Math.PI * position * (m + 1)));
        this.g[i] = (patch.gains[m] ?? 0.5) * (0.25 + 0.75 * comb) * 0.6 * pair;
        this.y1[i] = 0;
        this.y2[i] = 0;
      }
    }
    // Velocity hardens the mallet: shorter, brighter excitation.
    const hardness = tshift(patch.hardness, tim, 0.4) * (0.6 + velocity * 0.6);
    this.exciteFrames = Math.max(
      4,
      Math.round(((1 - Math.min(1, hardness)) * 0.002 + 0.0002) * sampleRate),
    );
    this.exciteLevel = velocity;
    this.tailFrames = Math.round(longestT60 * sampleRate * 1.2);
    this.gain = patch.gain;
    this.setPan(patch.pan);
    this.begin(0.0003);
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      let x = 0;
      if (this.age < this.exciteFrames) {
        const ph = this.age / this.exciteFrames;
        x = 0.5 * (1 - Math.cos(TWO_PI * ph)) * this.exciteLevel;
        x += this.rng.range(-0.05, 0.05) * this.exciteLevel;
      }
      let s = 0;
      for (let m = 0; m < this.modeCount; m++) {
        const y = this.c1[m]! * this.y1[m]! - this.r2[m]! * this.y2[m]! + x * this.g[m]!;
        this.y2[m] = this.y1[m]!;
        this.y1[m] = y;
        s += y;
      }
      this.age += 1;
      this.mix(l, r, i, s * this.gain * 0.5 * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (this.age > this.exciteFrames + this.tailFrames) this.active = false;
    for (let m = 0; m < this.modeCount; m++) {
      if (Math.abs(this.y1[m]!) < 1e-24) this.y1[m] = 0;
      if (Math.abs(this.y2[m]!) < 1e-24) this.y2[m] = 0;
    }
  }
}

/** A granular-ish noise grain through a bandpass: the rattle's shaker side. */
class ShakerVoice extends Voice {
  private svfLow = 0;
  private svfBand = 0;
  private svfF = 0.2;
  private decayTau = 1;
  private gain = 1;
  private rng!: WorkletRng;

  start(velocity: number, patch: ShakerPatch, rng: WorkletRng, tim = 0.5): void {
    this.rng = rng;
    this.svfLow = 0;
    this.svfBand = 0;
    const centre = patch.centreHz * (1 + (tim - 0.5) * 0.6) * rng.range(0.85, 1.15);
    this.svfF = 2 * Math.sin((Math.PI * Math.min(centre, sampleRate * 0.4)) / sampleRate);
    this.decayTau = patch.decay * sampleRate * rng.range(0.8, 1.2);
    this.gain = patch.gain * velocity;
    this.setPan(rng.range(-0.4, 0.4));
    this.begin(0.002);
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const env = Math.exp(-this.age / this.decayTau);
      const n = this.rng.range(-1, 1);
      this.svfLow += this.svfF * this.svfBand;
      const high = n - this.svfLow - 0.8 * this.svfBand;
      this.svfBand += this.svfF * high;
      this.age += 1;
      this.mix(l, r, i, this.svfBand * env * this.gain * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (this.age > this.decayTau * 8) this.active = false;
  }
}

/** Sustained Karplus variant with continuous noise excitation: the bow. */
class BowedVoice extends Voice {
  private buf = new Float32Array(4096);
  private len = 1;
  private pos = 0;
  private lp = 0;
  private damp = 0.3;
  private loopGain = 0.997;
  private pressure = 0;
  private targetPressure = 0;
  private gateFrames = 0;
  private releaseTau = 1;
  private gain = 1;
  private tremDepth = 0;
  private tremPhase = 0;
  private tremInc = 0;
  private rng!: WorkletRng;

  start(
    freq: number,
    velocity: number,
    durFrames: number,
    patch: BowedPatch,
    rng: WorkletRng,
    tim = 0.5,
  ): void {
    this.rng = rng;
    const f = freq * centsRatio(patch.detuneCents + rng.range(-3, 3));
    this.len = Math.max(2, Math.min(this.buf.length, Math.round(sampleRate / f)));
    this.buf.fill(0, 0, this.len);
    this.pos = 0;
    this.lp = 0;
    this.damp = 0.2 + tshift(patch.brightness, tim, 0.4) * 0.5;
    this.loopGain = 0.997;
    this.pressure = 0;
    this.targetPressure = tshift(patch.pressure, tim, 0.3) * (0.5 + velocity * 0.5);
    this.gateFrames = durFrames;
    this.releaseTau = 0.12 * sampleRate;
    this.gain = patch.gain;
    this.tremDepth = (patch.trem ?? 0) * (0.6 + tim * 0.8);
    this.tremPhase = rng.next();
    this.tremInc = ((patch.tremRate ?? 3.4) * rng.range(0.9, 1.1)) / sampleRate;
    this.setPan(patch.pan);
    this.begin(0.002);
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    const buf = this.buf;
    const bowAttack = 1 / (0.08 * sampleRate);
    for (let i = from; i < to; i++) {
      if (this.age < this.gateFrames) {
        this.pressure += (this.targetPressure - this.pressure) * bowAttack;
      } else {
        this.pressure *= Math.exp(-1 / this.releaseTau);
        this.loopGain = 0.993;
      }
      const out = buf[this.pos]!;
      this.lp += this.damp * (out - this.lp);
      buf[this.pos] = this.lp * this.loopGain + this.rng.range(-1, 1) * this.pressure * 0.02;
      this.pos = (this.pos + 1) % this.len;
      this.tremPhase += this.tremInc;
      if (this.tremPhase >= 1) this.tremPhase -= 1;
      const trem = 1 - this.tremDepth * (0.5 + 0.5 * Math.sin(TWO_PI * this.tremPhase));
      this.age += 1;
      this.mix(l, r, i, out * trem * this.gain * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (Math.abs(this.lp) < 1e-24) this.lp = 0;
    if (this.age > this.gateFrames + sampleRate * 1.5 && this.pressure < 1e-5) this.active = false;
  }
}

/** A waveguide pipe for drones; a swept noise swell for risers. */
class PipeVoice extends Voice {
  private buf = new Float32Array(4096);
  private len = 1;
  private pos = 0;
  private lpRefl = 0;
  private lpNoise = 0;
  private drive = 0;
  private targetDrive = 0;
  private attackTau = 1;
  private gateFrames = 0;
  private releaseTau = 1;
  private gain = 1;
  private riser = false;
  private svfLow = 0;
  private svfBand = 0;
  private riserFrom = 300;
  private riserTo = 2400;
  private cutoff = 0.2;
  private chiffFrames = 0;
  private tremDepth = 0;
  private tremPhase = 0;
  private tremInc = 0;
  private rng!: WorkletRng;

  start(
    freq: number | undefined,
    velocity: number,
    durFrames: number,
    articulation: string,
    patch: PipePatch,
    rng: WorkletRng,
    tim = 0.5,
  ): void {
    this.rng = rng;
    this.riser = articulation === 'riser';
    this.gateFrames = durFrames;
    this.gain = patch.gain * velocity;
    this.releaseTau = 0.4 * sampleRate;
    this.attackTau = Math.min(1.2, durFrames / sampleRate / 3) * sampleRate;
    this.drive = 0;
    this.targetDrive = 1;
    // A slow amplitude breath: the drone sways rather than holds.
    this.tremDepth = this.riser ? 0 : (patch.trem ?? 0) * (0.6 + tim * 0.8);
    this.tremPhase = rng.next();
    this.tremInc = ((patch.tremRate ?? 0.6) * rng.range(0.85, 1.15)) / sampleRate;
    this.setPan(rng.range(-0.2, 0.2));

    if (this.riser) {
      this.svfLow = 0;
      this.svfBand = 0;
      this.riserFrom = 250 * rng.range(0.9, 1.1);
      this.riserTo = 2400 * rng.range(0.85, 1.15);
    } else {
      const f = (freq ?? 65) * centsRatio(rng.range(-4, 4));
      this.len = Math.max(2, Math.min(this.buf.length, Math.round(sampleRate / f)));
      this.buf.fill(0, 0, this.len);
      this.pos = 0;
      this.lpRefl = 0;
      this.cutoff = 0.08 + tshift(patch.cutoff, tim, 0.4) * 0.3;
      this.chiffFrames = Math.round(0.03 * sampleRate) * (patch.chiff > 0 ? 1 : 0);
    }
    this.begin(0.002);
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      if (this.age < this.gateFrames) {
        this.drive += (this.targetDrive - this.drive) / this.attackTau;
      } else {
        this.drive *= Math.exp(-1 / this.releaseTau);
      }

      let s: number;
      if (this.riser) {
        const t = Math.min(1, this.age / Math.max(1, this.gateFrames));
        const centre = this.riserFrom * Math.pow(this.riserTo / this.riserFrom, t);
        const f1 = 2 * Math.sin((Math.PI * centre) / sampleRate);
        const n = this.rng.range(-1, 1);
        this.svfLow += f1 * this.svfBand;
        const high = n - this.svfLow - 1.2 * this.svfBand;
        this.svfBand += f1 * high;
        s = this.svfBand * this.drive * (0.3 + 0.7 * t);
      } else {
        // Pink-ish breath into the pipe, with a chiff at the lips.
        this.lpNoise += 0.04 * (this.rng.range(-1, 1) - this.lpNoise);
        let breath = this.lpNoise * 3 * this.drive * 0.025;
        if (this.age < this.chiffFrames) {
          breath += this.rng.range(-1, 1) * 0.05 * (1 - this.age / this.chiffFrames);
        }
        const out = this.buf[this.pos]!;
        this.lpRefl += this.cutoff * (out - this.lpRefl);
        this.buf[this.pos] = this.lpRefl * 0.97 + breath;
        this.pos = (this.pos + 1) % this.len;
        s = out;
        this.tremPhase += this.tremInc;
        if (this.tremPhase >= 1) this.tremPhase -= 1;
        s *= 1 - this.tremDepth * (0.5 + 0.5 * Math.sin(TWO_PI * this.tremPhase));
      }

      this.age += 1;
      this.mix(l, r, i, s * this.gain * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (Math.abs(this.lpRefl) < 1e-24) this.lpRefl = 0;
    if (this.age > this.gateFrames + sampleRate * 2 && this.drive < 1e-5) this.active = false;
  }
}

/**
 * Morphing wavetable with a breath-noise layer and delayed vibrato. Two
 * detuned reads of the same table chorus against each other, the morph
 * position drifts slowly across the note, and a one-pole lowpass tracks
 * velocity so soft notes are soft in colour, not just in level.
 */
class WavetableVoice extends Voice {
  private tables: TablesPayload | undefined;
  private mipBase = 0;
  private mipBase2 = 0;
  private morphFrac = 0;
  private morphStep = 0;
  private phase = 0;
  private phase2 = 0;
  private inc = 0;
  private incTarget = 0;
  private glideCoef = 1;
  private unisonRatio = 1;
  private uGain = 0.45;
  private tremDepth = 0;
  private tremPhase = 0;
  private tremInc = 0;
  private baseFreq = 220;
  private gateFrames = 0;
  private attackTau = 1;
  private releaseTau = 1;
  private env = 0;
  private breathGain = 0;
  private lpNoise = 0;
  private lpTone = 0;
  private lpCoef = 1;
  private vibPhase = 0;
  private vibInc = 0;
  private vibDepth = 0;
  private vibOnset = 1;
  private gain = 1;
  private rng!: WorkletRng;

  start(
    freq: number,
    velocity: number,
    durFrames: number,
    patch: WavetablePatch,
    tables: TablesPayload,
    rng: WorkletRng,
    tim = 0.5,
    glideFrom?: number,
    glideBoost = 0,
  ): void {
    this.rng = rng;
    this.tables = tables;
    this.baseFreq = freq * centsRatio(patch.detuneCents + rng.range(-2, 2));
    this.incTarget = this.baseFreq / sampleRate;
    // Portamento: a note close on the heels of another glides in from its
    // pitch; a moon change boosts the glide so the whole line slides into
    // the new key.
    const glide = (patch.glide ?? 0) * (1 + 3 * glideBoost);
    if (glideFrom !== undefined && glide > 0.005) {
      this.inc = glideFrom / sampleRate;
      this.glideCoef = Math.min(1, 3 / (glide * sampleRate));
    } else {
      this.inc = this.incTarget;
      this.glideCoef = 1;
    }
    // Unison: the detuned partner spreads wider as the parameter rises.
    const uni = Math.max(0, Math.min(1, patch.unison ?? 0.5));
    this.unisonRatio = centsRatio(rng.range(2, 4) + uni * 9);
    this.uGain = 0.2 + uni * 0.5;
    this.tremDepth = (patch.trem ?? 0) * (0.7 + tim * 0.6);
    this.tremPhase = rng.next();
    this.tremInc = ((patch.tremRate ?? 4.2) * rng.range(0.9, 1.1)) / sampleRate;
    this.phase = rng.next();
    this.phase2 = rng.next();

    // Mip by frequency: the largest partial cap that stays under Nyquist.
    const maxPartials = Math.floor(sampleRate / 2 / this.baseFreq);
    let mip = MIP_CAPS.length - 1;
    for (let i = 0; i < MIP_CAPS.length; i++) {
      if ((MIP_CAPS[i] ?? 64) <= maxPartials) {
        mip = i;
        break;
      }
    }
    // Morph position selects the table pair; the note's timbre shifts it and
    // it keeps moving gently while the note sounds.
    const morph = clamp01(tshift(patch.morph, tim, 0.7) + rng.range(-0.06, 0.06));
    const mt = morph * (tables.tableCount - 1);
    const t0 = Math.min(tables.tableCount - 2, Math.floor(mt));
    this.morphFrac = mt - t0;
    this.morphStep = (rng.range(-1, 1) * 0.3) / Math.max(1, durFrames);
    this.mipBase = (t0 * tables.mipCount + mip) * tables.size;
    this.mipBase2 = ((t0 + 1) * tables.mipCount + mip) * tables.size;

    this.gateFrames = durFrames;
    this.attackTau = Math.max(1, patch.attack * sampleRate);
    this.releaseTau = Math.max(1, patch.release * sampleRate);
    this.env = 0;
    this.breathGain = tshift(patch.breath, tim, 0.15);
    this.lpTone = 0;
    const cutoffHz = 500 + velocity * 6500 + tim * 3000;
    this.lpCoef = Math.min(1, (TWO_PI * cutoffHz) / sampleRate);
    this.vibPhase = rng.next();
    this.vibInc = (patch.vibratoRate * rng.range(0.92, 1.08)) / sampleRate;
    this.vibDepth = patch.vibratoCents;
    this.vibOnset = Math.max(1, durFrames * 0.35);
    this.gain = patch.gain * velocity;
    this.setPan(patch.pan + rng.range(-0.1, 0.1));
    this.begin(0.001);
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    const tables = this.tables;
    if (!tables) {
      this.active = false;
      return;
    }
    const data = tables.data;
    const size = tables.size;
    for (let i = from; i < to; i++) {
      if (this.age < this.gateFrames) {
        this.env += (1 - this.env) / this.attackTau;
      } else {
        this.env *= Math.exp(-1 / this.releaseTau);
      }

      // The glide chases its target pitch; vibrato arrives once settled.
      this.inc += (this.incTarget - this.inc) * this.glideCoef;
      this.vibPhase += this.vibInc;
      if (this.vibPhase >= 1) this.vibPhase -= 1;
      const onset = Math.min(1, this.age / this.vibOnset);
      const cents = this.vibDepth * onset * Math.sin(TWO_PI * this.vibPhase);
      const bend = 1 + cents * 0.000578;
      this.phase += this.inc * bend;
      if (this.phase >= 1) this.phase -= 1;
      this.phase2 += this.inc * this.unisonRatio * bend;
      if (this.phase2 >= 1) this.phase2 -= 1;

      this.morphFrac += this.morphStep;
      if (this.morphFrac < 0) this.morphFrac = 0;
      else if (this.morphFrac > 1) this.morphFrac = 1;

      let s = this.readMorphed(data, size, this.phase);
      s = s * 0.7 + this.readMorphed(data, size, this.phase2) * this.uGain;

      this.lpNoise += 0.05 * (this.rng.range(-1, 1) - this.lpNoise);
      s += this.lpNoise * 3 * this.breathGain;

      this.lpTone += this.lpCoef * (s - this.lpTone);

      this.tremPhase += this.tremInc;
      if (this.tremPhase >= 1) this.tremPhase -= 1;
      const trem = 1 - this.tremDepth * onset * (0.5 + 0.5 * Math.sin(TWO_PI * this.tremPhase));

      this.age += 1;
      this.mix(l, r, i, this.lpTone * trem * this.env * this.gain * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (this.age > this.gateFrames && this.env < 1e-5) this.active = false;
  }

  private readMorphed(data: Float32Array, size: number, phase: number): number {
    const idx = phase * size;
    const i0 = Math.floor(idx) % size;
    const i1 = (i0 + 1) % size;
    const frac = idx - Math.floor(idx);
    const a = data[this.mipBase + i0]! + (data[this.mipBase + i1]! - data[this.mipBase + i0]!) * frac;
    const b =
      data[this.mipBase2 + i0]! + (data[this.mipBase2 + i1]! - data[this.mipBase2 + i0]!) * frac;
    return a + (b - a) * this.morphFrac;
  }
}

/**
 * The World: a hidden eighth voice that always plays, even when all seven
 * sleep, so the valley never falls into dead air. Quiet wind noise, a distant
 * low rumble, and rare ember crackle, all scaled by the wind state.
 */
class WorldVoice {
  private rng: WorkletRng;
  private windLpL = 0;
  private windLpR = 0;
  private rumblePhase = 0;
  private rumbleLfo = 0;
  private crackleLife = 0;
  private crackleAmp = 0;
  private crackleLp = 0;
  private nextCrackle: number;
  private wind = 0;

  constructor(seed: number) {
    this.rng = new WorkletRng(seed >>> 0);
    this.nextCrackle = this.rng.range(0.5, 2) * sampleRate;
  }

  reseed(seed: number): void {
    this.rng = new WorkletRng(seed >>> 0);
  }

  setWind(w: number): void {
    this.wind = Math.max(0, Math.min(2, w));
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    // A faint bed: present enough to banish dead air, quiet enough never to
    // mask the seven. Scaled gently by the wind.
    const windGain = (0.5 + this.wind * 0.5) * 0.035;
    const crackleWindow = 0.04 * sampleRate;
    for (let i = from; i < to; i++) {
      // Wind: two decorrelated one-pole lowpassed noises for stereo width.
      this.windLpL += 0.04 * (this.rng.range(-1, 1) - this.windLpL);
      this.windLpR += 0.045 * (this.rng.range(-1, 1) - this.windLpR);

      // Distant rumble: a low sine under a very slow swell.
      this.rumbleLfo += 0.00002;
      const rumbleEnv = 0.5 + 0.5 * Math.sin(this.rumbleLfo);
      this.rumblePhase += 41 / sampleRate;
      if (this.rumblePhase >= 1) this.rumblePhase -= 1;
      const rumble = Math.sin(TWO_PI * this.rumblePhase) * rumbleEnv * 0.02;

      // Ember crackle: sparse short bursts, more frequent on a stronger wind.
      this.nextCrackle -= 1;
      if (this.nextCrackle <= 0 && this.crackleLife <= 0) {
        this.crackleLife = Math.round(this.rng.range(0.01, 0.05) * sampleRate);
        this.crackleAmp = this.rng.range(0.03, 0.08) * (0.6 + this.wind * 0.4);
        const gap = this.rng.range(0.6, 3) / (0.5 + this.wind * 0.6);
        this.nextCrackle = Math.round(gap * sampleRate);
      }
      let crackle = 0;
      if (this.crackleLife > 0) {
        this.crackleLife -= 1;
        this.crackleLp += 0.5 * (this.rng.range(-1, 1) - this.crackleLp);
        crackle = this.crackleLp * this.crackleAmp * Math.min(1, this.crackleLife / crackleWindow);
      }

      l[i] = l[i]! + this.windLpL * windGain + rumble + crackle;
      r[i] = r[i]! + this.windLpR * windGain + rumble + crackle * 0.8;
    }
  }
}

class VybezCore extends AudioWorkletProcessor {
  private queue: QueuedNote[] = [];
  private patches: PatchesMessage | undefined;
  private noteCount = 0;

  private strings = Array.from({ length: 4 }, () => new StringVoice());
  private drums = Array.from({ length: 10 }, () => new DrumVoice());
  private rattles = Array.from({ length: 4 }, () => new ModalVoice());
  private shakers = Array.from({ length: 3 }, () => new ShakerVoice());
  private tines = Array.from({ length: 6 }, () => new ModalVoice());
  private bows = Array.from({ length: 3 }, () => new BowedVoice());
  private pipes = Array.from({ length: 5 }, () => new PipeVoice());
  private leads = Array.from({ length: 6 }, () => new WavetableVoice());
  private world = new WorldVoice(1);

  // Space state: the fire pulls the valley close and dry; sky strums open the
  // cavern for a dozen seconds; a moon change makes the lead glide for a few.
  private spaceFire = 0.6;
  private glow = 0;
  private glideBoost = 0;
  private static readonly GLOW_DECAY = Math.exp(-128 / (12 * sampleRate));
  private static readonly GLIDE_DECAY = Math.exp(-128 / (3 * sampleRate));

  // Per-pool scratch: each spirit renders here, then fans out to the dry mix
  // and its own send levels on the three effect outputs.
  private scrL = new Float32Array(128);
  private scrR = new Float32Array(128);

  private lastLeadFreq: number | undefined;
  private lastLeadFrame = -1e15;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<InMessage>) => {
      const msg = e.data;
      if (msg.type === 'patches') {
        this.patches = msg;
        this.world.reseed(msg.seed);
        return;
      }
      if (msg.type === 'world') {
        this.world.setWind(msg.wind);
        return;
      }
      if (msg.type === 'space') {
        this.spaceFire = Math.max(0, Math.min(1, msg.fire));
        return;
      }
      if (msg.type === 'glow') {
        this.glow = Math.min(1, this.glow + 0.35);
        return;
      }
      if (msg.type === 'glide') {
        this.glideBoost = 1;
        return;
      }
      if (msg.type === 'patch-update') {
        // The dev rig edits a patch slot live; merge it over the current one.
        if (this.patches) {
          const slot = this.patches[msg.key] as unknown as Record<string, number>;
          Object.assign(slot, msg.patch);
        }
        return;
      }
      const startFrame = Math.max(0, Math.round(msg.when * sampleRate));
      const note: QueuedNote = { ...msg, startFrame };
      let i = this.queue.length;
      while (i > 0 && this.queue[i - 1]!.startFrame > startFrame) i--;
      this.queue.splice(i, 0, note);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out) return true;
    const l = out[0];
    const r = out[1] ?? out[0];
    if (!l || !r) return true;
    const aL = outputs[1]?.[0];
    const aR = outputs[1]?.[1] ?? aL;
    const bL = outputs[2]?.[0];
    const bR = outputs[2]?.[1] ?? bL;
    const dL = outputs[3]?.[0];
    const dR = outputs[3]?.[1] ?? dL;
    if (this.scrL.length < l.length) {
      this.scrL = new Float32Array(l.length);
      this.scrR = new Float32Array(l.length);
    }
    this.glow *= VybezCore.GLOW_DECAY;
    this.glideBoost *= VybezCore.GLIDE_DECAY;

    const blockStart = currentFrame;
    const blockEnd = blockStart + l.length;

    let cursor = 0;
    while (this.queue.length > 0 && this.queue[0]!.startFrame < blockEnd) {
      const note = this.queue.shift()!;
      const offset = Math.max(0, note.startFrame - blockStart);
      this.renderVoices(l, r, aL, aR, bL, bR, dL, dR, cursor, offset);
      cursor = offset;
      this.startNote(note);
    }
    this.renderVoices(l, r, aL, aR, bL, bR, dL, dR, cursor, l.length);
    return true;
  }

  private renderVoices(
    l: Float32Array,
    r: Float32Array,
    aL: Float32Array | undefined,
    aR: Float32Array | undefined,
    bL: Float32Array | undefined,
    bR: Float32Array | undefined,
    dL: Float32Array | undefined,
    dR: Float32Array | undefined,
    from: number,
    to: number,
  ): void {
    if (from >= to) return;
    const p = this.patches;
    // The cavern opens as the fire dies and while strums still glow; the
    // delay bank answers a little louder under the glow too.
    const revMul = (0.75 + 0.5 * (1 - this.spaceFire)) * (1 + 0.9 * this.glow);
    const dlyMul = 1 + 0.6 * this.glow;
    const routes: Array<[Voice[], Sends | undefined]> = [
      [this.strings, p?.root],
      [this.drums, p?.drum],
      [this.rattles, p?.rattle],
      [this.shakers, p?.shaker],
      [this.tines, p?.spinner],
      [this.bows, p?.echo],
      [this.pipes, p?.breath],
      [this.leads, p?.voice],
    ];
    const scrL = this.scrL;
    const scrR = this.scrR;
    for (const [pool, sends] of routes) {
      let any = false;
      for (const v of pool) {
        if (v.active) {
          any = true;
          break;
        }
      }
      if (!any) continue;
      scrL.fill(0, from, to);
      scrR.fill(0, from, to);
      for (const v of pool) if (v.active) v.render(scrL, scrR, from, to);
      const ra = (sends?.revA ?? 0) * revMul;
      const rb = sends?.revB ?? 0;
      const dy = (sends?.dly ?? 0) * dlyMul;
      for (let i = from; i < to; i++) {
        const sl = scrL[i]!;
        const sr = scrR[i]!;
        l[i] = l[i]! + sl;
        r[i] = r[i]! + sr;
        if (aL && aR) {
          aL[i] = aL[i]! + sl * ra;
          aR[i] = aR[i]! + sr * ra;
        }
        if (bL && bR) {
          bL[i] = bL[i]! + sl * rb;
          bR[i] = bR[i]! + sr * rb;
        }
        if (dL && dR) {
          dL[i] = dL[i]! + sl * dy;
          dR[i] = dR[i]! + sr * dy;
        }
      }
    }
    // The World always plays; no dead air, even when all seven sleep. It sits
    // lightly in the near room so it shares the valley's air.
    scrL.fill(0, from, to);
    scrR.fill(0, from, to);
    this.world.render(scrL, scrR, from, to);
    for (let i = from; i < to; i++) {
      const sl = scrL[i]!;
      const sr = scrR[i]!;
      l[i] = l[i]! + sl;
      r[i] = r[i]! + sr;
      if (bL && bR) {
        bL[i] = bL[i]! + sl * 0.12;
        bR[i] = bR[i]! + sr * 0.12;
      }
    }
  }

  private startNote(note: QueuedNote): void {
    const p = this.patches;
    if (!p) return;
    this.noteCount += 1;
    const rng = new WorkletRng((p.seed ^ Math.imul(this.noteCount, 0x9e3779b1)) >>> 0);
    const durFrames = Math.round(note.duration * sampleRate);
    const freq = note.midi !== undefined ? midiToFreq(note.midi) : undefined;
    const tim = note.timbre ?? 0.5;

    switch (note.spirit) {
      case 'root':
        if (freq !== undefined) {
          this.claim(this.strings).start(freq, note.velocity, durFrames, p.root, rng, tim);
        }
        break;
      case 'drum': {
        const kind =
          note.articulation === 'snare' ? 'snare' : note.articulation === 'tom' ? 'tom' : 'kick';
        this.claim(this.drums).start(kind, note.velocity, p.drum, rng, tim);
        break;
      }
      case 'rattle':
        if (note.articulation === 'ghost') {
          this.claim(this.shakers).start(note.velocity, p.shaker, rng, tim);
        } else if (freq !== undefined) {
          this.claim(this.rattles).start(freq, note.velocity, p.rattle, rng, tim);
        }
        break;
      case 'spinner':
        if (freq !== undefined) {
          this.claim(this.tines).start(freq, note.velocity, p.spinner, rng, tim);
        }
        break;
      case 'voice':
        if (freq !== undefined) {
          // Portamento memory: a note hard on the heels of the last one
          // glides in from its pitch, so lines flow instead of stepping.
          const recent =
            currentFrame - this.lastLeadFrame < 0.6 * sampleRate ? this.lastLeadFreq : undefined;
          this.claim(this.leads).start(
            freq,
            note.velocity,
            durFrames,
            p.voice,
            p.tables,
            rng,
            tim,
            recent,
            this.glideBoost,
          );
          this.lastLeadFreq = freq;
          this.lastLeadFrame = currentFrame;
        }
        break;
      case 'echo':
        if (freq !== undefined) {
          this.claim(this.bows).start(freq, note.velocity, durFrames, p.echo, rng, tim);
        }
        break;
      case 'breath':
        this.claim(this.pipes).start(
          freq,
          note.velocity,
          durFrames,
          note.articulation ?? 'drone',
          p.breath,
          rng,
          tim,
        );
        break;
    }
  }

  private claim<T extends Voice>(pool: T[]): T {
    let oldest = pool[0]!;
    for (const v of pool) {
      if (!v.active) return v;
      if (v.age > oldest.age) oldest = v;
    }
    oldest.steal();
    return oldest;
  }
}

registerProcessor('vybez-core', VybezCore);
