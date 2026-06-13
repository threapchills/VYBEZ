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
}

interface RootPatch {
  brightness: number;
  subMix: number;
  pan: number;
  gain: number;
  detuneCents: number;
}

interface DrumPatch {
  tone: number;
  decay: number;
  pan: number;
  gain: number;
}

interface ModalPatch {
  ratios: number[];
  gains: number[];
  t60s: number[];
  hardness: number;
  position: number;
  dampTilt: number;
  pan: number;
  gain: number;
}

interface ShakerPatch {
  centreHz: number;
  decay: number;
  gain: number;
}

interface BowedPatch {
  brightness: number;
  pressure: number;
  pan: number;
  gain: number;
  detuneCents: number;
}

interface PipePatch {
  cutoff: number;
  chiff: number;
  pan: number;
  gain: number;
}

interface WavetablePatch {
  morph: number;
  breath: number;
  vibratoCents: number;
  vibratoRate: number;
  attack: number;
  release: number;
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

type InMessage = NoteMessage | PatchesMessage | PatchUpdateMessage | WorldMessage;

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
  ): void {
    const f = freq * centsRatio(patch.detuneCents + rng.range(-2, 2));
    this.len = Math.max(2, Math.min(this.buf.length, Math.round(sampleRate / f)));
    this.pos = 0;
    this.lp = 0;
    this.loopGain = 0.995 + 0.004 * Math.min(1, durFrames / sampleRate);
    this.damp = 0.25 + patch.brightness * 0.55;
    this.gateFrames = durFrames;
    this.gain = patch.gain * velocity;
    this.setPan(patch.pan);

    const cutoff = 0.15 + patch.brightness * 0.75 * velocity;
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

  start(kind: 'kick' | 'snare' | 'tom', velocity: number, patch: DrumPatch, rng: WorkletRng): void {
    this.kind = kind;
    this.rng = rng;
    this.phase = 0;
    this.phase2 = 0;
    this.svfLow = 0;
    this.svfBand = 0;
    const decay = 0.6 + patch.decay * 0.8;
    const hard = 0.7 + velocity * 0.6;

    if (kind === 'kick') {
      this.freq = (88 + patch.tone * 40) * hard * rng.range(0.97, 1.03);
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
      this.noiseLevel = (0.5 + patch.tone * 0.4) * velocity;
      this.noiseTau = 0.11 * decay * sampleRate;
      this.svfF = 2 * Math.sin((Math.PI * (1400 + patch.tone * 1200)) / sampleRate);
    } else {
      this.freq = (96 + patch.tone * 50) * rng.range(0.96, 1.04);
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

  start(freq: number, velocity: number, patch: ModalPatch, rng: WorkletRng): void {
    this.rng = rng;
    this.modeCount = 0;
    let longestT60 = 0.1;
    const nyq = sampleRate * 0.45;
    for (let m = 0; m < Math.min(patch.ratios.length, ModalVoice.MAX_MODES); m++) {
      // Seeded modal jitter within material tolerances.
      const f = freq * (patch.ratios[m] ?? 1) * rng.range(0.996, 1.004);
      if (f >= nyq) continue;
      const i = this.modeCount++;
      // Damping tilt: high modes die faster.
      const t60 = (patch.t60s[m] ?? 0.5) * Math.pow(patch.dampTilt, m);
      longestT60 = Math.max(longestT60, t60);
      const radius = Math.pow(10, -3 / (t60 * sampleRate));
      const theta = (TWO_PI * f) / sampleRate;
      this.c1[i] = 2 * radius * Math.cos(theta);
      this.r2[i] = radius * radius;
      // Strike position combs the mode gains.
      const comb = Math.abs(Math.sin(Math.PI * patch.position * (m + 1)));
      this.g[i] = (patch.gains[m] ?? 0.5) * (0.25 + 0.75 * comb);
      this.y1[i] = 0;
      this.y2[i] = 0;
    }
    // Velocity hardens the mallet: shorter, brighter excitation.
    const hardness = patch.hardness * (0.6 + velocity * 0.6);
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

  start(velocity: number, patch: ShakerPatch, rng: WorkletRng): void {
    this.rng = rng;
    this.svfLow = 0;
    this.svfBand = 0;
    const centre = patch.centreHz * rng.range(0.85, 1.15);
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
  private rng!: WorkletRng;

  start(
    freq: number,
    velocity: number,
    durFrames: number,
    patch: BowedPatch,
    rng: WorkletRng,
  ): void {
    this.rng = rng;
    const f = freq * centsRatio(patch.detuneCents + rng.range(-3, 3));
    this.len = Math.max(2, Math.min(this.buf.length, Math.round(sampleRate / f)));
    this.buf.fill(0, 0, this.len);
    this.pos = 0;
    this.lp = 0;
    this.damp = 0.2 + patch.brightness * 0.5;
    this.loopGain = 0.997;
    this.pressure = 0;
    this.targetPressure = patch.pressure * (0.5 + velocity * 0.5);
    this.gateFrames = durFrames;
    this.releaseTau = 0.12 * sampleRate;
    this.gain = patch.gain;
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
      this.age += 1;
      this.mix(l, r, i, out * this.gain * this.stepFade() * this.attack());
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
  private rng!: WorkletRng;

  start(
    freq: number | undefined,
    velocity: number,
    durFrames: number,
    articulation: string,
    patch: PipePatch,
    rng: WorkletRng,
  ): void {
    this.rng = rng;
    this.riser = articulation === 'riser';
    this.gateFrames = durFrames;
    this.gain = patch.gain * velocity;
    this.releaseTau = 0.4 * sampleRate;
    this.attackTau = Math.min(1.2, durFrames / sampleRate / 3) * sampleRate;
    this.drive = 0;
    this.targetDrive = 1;
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
      this.cutoff = 0.08 + patch.cutoff * 0.3;
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
      }

      this.age += 1;
      this.mix(l, r, i, s * this.gain * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (Math.abs(this.lpRefl) < 1e-24) this.lpRefl = 0;
    if (this.age > this.gateFrames + sampleRate * 2 && this.drive < 1e-5) this.active = false;
  }
}

/** Morphing wavetable with a breath-noise layer and delayed vibrato. */
class WavetableVoice extends Voice {
  private tables: TablesPayload | undefined;
  private mipBase = 0;
  private mipBase2 = 0;
  private morphFrac = 0;
  private phase = 0;
  private inc = 0;
  private baseFreq = 220;
  private gateFrames = 0;
  private attackTau = 1;
  private releaseTau = 1;
  private env = 0;
  private breathGain = 0;
  private lpNoise = 0;
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
  ): void {
    this.rng = rng;
    this.tables = tables;
    this.baseFreq = freq * centsRatio(patch.detuneCents + rng.range(-2, 2));
    this.inc = this.baseFreq / sampleRate;
    this.phase = rng.next();

    // Mip by frequency: the largest partial cap that stays under Nyquist.
    const maxPartials = Math.floor(sampleRate / 2 / this.baseFreq);
    let mip = MIP_CAPS.length - 1;
    for (let i = 0; i < MIP_CAPS.length; i++) {
      if ((MIP_CAPS[i] ?? 64) <= maxPartials) {
        mip = i;
        break;
      }
    }
    // Morph position selects the table pair; micro-varied per note.
    const morph = Math.max(0, Math.min(1, patch.morph + rng.range(-0.06, 0.06)));
    const mt = morph * (tables.tableCount - 1);
    const t0 = Math.min(tables.tableCount - 2, Math.floor(mt));
    this.morphFrac = mt - t0;
    this.mipBase = (t0 * tables.mipCount + mip) * tables.size;
    this.mipBase2 = ((t0 + 1) * tables.mipCount + mip) * tables.size;

    this.gateFrames = durFrames;
    this.attackTau = Math.max(1, patch.attack * sampleRate);
    this.releaseTau = Math.max(1, patch.release * sampleRate);
    this.env = 0;
    this.breathGain = patch.breath;
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

      // Vibrato arrives only after the note has settled.
      this.vibPhase += this.vibInc;
      if (this.vibPhase >= 1) this.vibPhase -= 1;
      const onset = Math.min(1, this.age / this.vibOnset);
      const cents = this.vibDepth * onset * Math.sin(TWO_PI * this.vibPhase);
      this.phase += this.inc * (1 + cents * 0.000578);
      if (this.phase >= 1) this.phase -= 1;

      const idx = this.phase * size;
      const i0 = Math.floor(idx) % size;
      const i1 = (i0 + 1) % size;
      const frac = idx - Math.floor(idx);
      const a =
        data[this.mipBase + i0]! + (data[this.mipBase + i1]! - data[this.mipBase + i0]!) * frac;
      const b =
        data[this.mipBase2 + i0]! + (data[this.mipBase2 + i1]! - data[this.mipBase2 + i0]!) * frac;
      let s = a + (b - a) * this.morphFrac;

      this.lpNoise += 0.05 * (this.rng.range(-1, 1) - this.lpNoise);
      s += this.lpNoise * 3 * this.breathGain;

      this.age += 1;
      this.mix(l, r, i, s * this.env * this.gain * this.stepFade() * this.attack());
      if (!this.active) return;
    }
    if (this.age > this.gateFrames && this.env < 1e-5) this.active = false;
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

  private strings = [new StringVoice(), new StringVoice(), new StringVoice()];
  private drums = Array.from({ length: 8 }, () => new DrumVoice());
  private rattles = Array.from({ length: 4 }, () => new ModalVoice());
  private shakers = Array.from({ length: 3 }, () => new ShakerVoice());
  private tines = Array.from({ length: 5 }, () => new ModalVoice());
  private bows = Array.from({ length: 3 }, () => new BowedVoice());
  private pipes = Array.from({ length: 5 }, () => new PipeVoice());
  private leads = Array.from({ length: 4 }, () => new WavetableVoice());
  private world = new WorldVoice(1);

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
    const blockStart = currentFrame;
    const blockEnd = blockStart + l.length;

    let cursor = 0;
    while (this.queue.length > 0 && this.queue[0]!.startFrame < blockEnd) {
      const note = this.queue.shift()!;
      const offset = Math.max(0, note.startFrame - blockStart);
      this.renderVoices(l, r, cursor, offset);
      cursor = offset;
      this.startNote(note);
    }
    this.renderVoices(l, r, cursor, l.length);
    return true;
  }

  private renderVoices(l: Float32Array, r: Float32Array, from: number, to: number): void {
    if (from >= to) return;
    for (const pool of [
      this.strings,
      this.drums,
      this.rattles,
      this.shakers,
      this.tines,
      this.bows,
      this.pipes,
      this.leads,
    ]) {
      for (const v of pool) if (v.active) v.render(l, r, from, to);
    }
    // The World always plays; no dead air, even when all seven sleep.
    this.world.render(l, r, from, to);
  }

  private startNote(note: QueuedNote): void {
    const p = this.patches;
    if (!p) return;
    this.noteCount += 1;
    const rng = new WorkletRng((p.seed ^ Math.imul(this.noteCount, 0x9e3779b1)) >>> 0);
    const durFrames = Math.round(note.duration * sampleRate);
    const freq = note.midi !== undefined ? midiToFreq(note.midi) : undefined;

    switch (note.spirit) {
      case 'root':
        if (freq !== undefined) {
          this.claim(this.strings).start(freq, note.velocity, durFrames, p.root, rng);
        }
        break;
      case 'drum': {
        const kind =
          note.articulation === 'snare' ? 'snare' : note.articulation === 'tom' ? 'tom' : 'kick';
        this.claim(this.drums).start(kind, note.velocity, p.drum, rng);
        break;
      }
      case 'rattle':
        if (note.articulation === 'ghost') {
          this.claim(this.shakers).start(note.velocity, p.shaker, rng);
        } else if (freq !== undefined) {
          this.claim(this.rattles).start(freq, note.velocity, p.rattle, rng);
        }
        break;
      case 'spinner':
        if (freq !== undefined) {
          this.claim(this.tines).start(freq, note.velocity, p.spinner, rng);
        }
        break;
      case 'voice':
        if (freq !== undefined) {
          this.claim(this.leads).start(freq, note.velocity, durFrames, p.voice, p.tables, rng);
        }
        break;
      case 'echo':
        if (freq !== undefined) {
          this.claim(this.bows).start(freq, note.velocity, durFrames, p.echo, rng);
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
