// Vybez Core: one worklet hosts all voices, message-driven, consuming a
// sample-stamped event queue. Phase 1 ships the Root (Karplus-Strong pluck
// over a sub layer) and the Drum (pitched kick, membrane snare, tom). The
// full patch architecture grows here in phase 2; the event plumbing, voice
// pooling, stealing fades and per-note micro-variation are already the real
// thing, because retrofitting those is how toys stay toys.

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
  damping: number;
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

interface PatchesMessage {
  type: 'patches';
  seed: number;
  root: RootPatch;
  drum: DrumPatch;
}

type InMessage = NoteMessage | PatchesMessage;

interface QueuedNote extends NoteMessage {
  startFrame: number;
}

const STEAL_FADE_S = 0.005;
const TWO_PI = Math.PI * 2;

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
  /** Short onset ramp so hard voice restarts never click. */
  protected attackFrames = 1;

  protected attack(): number {
    return this.age < this.attackFrames ? this.age / this.attackFrames : 1;
  }

  /** 5 ms fade instead of a click when the pool steals this voice. */
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
  private panL = 1;
  private panR = 1;

  start(
    freq: number,
    velocity: number,
    durFrames: number,
    patch: RootPatch,
    rng: WorkletRng,
  ): void {
    // Covenant rule 5: seeded detune per voice plus per-note micro-variation,
    // so repeated notes never machine-gun.
    const cents = patch.detuneCents + rng.range(-2, 2);
    const f = freq * Math.pow(2, cents / 1200);
    this.len = Math.max(2, Math.min(this.buf.length, Math.round(sampleRate / f)));
    this.pos = 0;
    this.lp = 0;
    this.loopGain = 0.995 + 0.004 * Math.min(1, durFrames / sampleRate);
    this.damp = 0.25 + patch.brightness * 0.55;
    this.gateFrames = durFrames;
    this.age = 0;
    this.fade = 1;
    this.fadeStep = 0;
    this.gain = patch.gain * velocity;
    const pan = patch.pan;
    this.panL = Math.cos(((pan + 1) / 2) * (Math.PI / 2));
    this.panR = Math.sin(((pan + 1) / 2) * (Math.PI / 2));

    // Excite: a velocity-bright noise burst, lowpassed into the line.
    const cutoff = 0.15 + patch.brightness * 0.75 * velocity;
    let filt = 0;
    for (let i = 0; i < this.len; i++) {
      const noise = rng.range(-1, 1);
      filt += cutoff * (noise - filt);
      this.buf[i] = filt;
    }
    // Pick-position comb: cancel a delayed copy for body.
    const pick = Math.floor(this.len * 0.27);
    for (let i = this.len - 1; i >= pick; i--) {
      this.buf[i] = this.buf[i]! - 0.5 * this.buf[i - pick]!;
    }

    this.subPhase = 0;
    this.subInc = f / 2 / sampleRate;
    this.subLevel = patch.subMix * velocity;
    // The sub breathes out across the note's own duration.
    this.subDecay = Math.exp(-1 / Math.max(1, durFrames * 0.9));
    this.attackFrames = Math.max(1, Math.round(0.0015 * sampleRate));
    this.active = true;
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

      const fade = this.stepFade() * this.attack();
      const s = (out + sub) * this.gain * fade;
      l[i] = l[i]! + s * this.panL;
      r[i] = r[i]! + s * this.panR;
      if (!this.active) return;
    }
    // Flush denormals and retire silent strings.
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
  private panL = 1;
  private panR = 1;
  private rng!: WorkletRng;

  start(kind: 'kick' | 'snare' | 'tom', velocity: number, patch: DrumPatch, rng: WorkletRng): void {
    this.kind = kind;
    this.rng = rng;
    this.phase = 0;
    this.phase2 = 0;
    this.age = 0;
    this.fade = 1;
    this.fadeStep = 0;
    this.svfLow = 0;
    this.svfBand = 0;
    const decay = 0.6 + patch.decay * 0.8;
    // Velocity widens the exciter spectrum the way real mallets do.
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
    const pan = patch.pan + (kind === 'tom' ? 0.15 : 0);
    this.panL = Math.cos(((pan + 1) / 2) * (Math.PI / 2));
    this.panR = Math.sin(((pan + 1) / 2) * (Math.PI / 2));
    this.attackFrames = Math.max(1, Math.round(0.0005 * sampleRate));
    this.active = true;
  }

  render(l: Float32Array, r: Float32Array, from: number, to: number): void {
    for (let i = from; i < to; i++) {
      const t = this.age;
      const f = this.freqEnd + (this.freq - this.freqEnd) * Math.exp(-t / this.freqTau);
      this.phase += f / sampleRate;
      const ampEnv = Math.exp(-t / this.ampTau);
      let s = Math.sin(TWO_PI * this.phase) * ampEnv;

      if (this.kind === 'snare') {
        // A second membrane mode a minor seventh up.
        this.phase2 += (f * 1.78) / sampleRate;
        s = s * 0.7 + Math.sin(TWO_PI * this.phase2) * ampEnv * 0.3;
      } else if (this.kind === 'tom') {
        this.phase2 += (f * 1.59) / sampleRate;
        s = s * 0.75 + Math.sin(TWO_PI * this.phase2) * ampEnv * 0.25;
      }

      // The noise component: chiff for the kick, wires for the snare.
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
      const fade = this.stepFade() * this.attack();
      const out = s * this.gain * fade;
      l[i] = l[i]! + out * this.panL;
      r[i] = r[i]! + out * this.panR;
      if (!this.active) return;
    }
    if (this.age > this.ampTau * 8 + this.noiseTau * 8) this.active = false;
  }
}

class VybezCore extends AudioWorkletProcessor {
  private queue: QueuedNote[] = [];
  private strings = [new StringVoice(), new StringVoice(), new StringVoice()];
  private drums = Array.from({ length: 8 }, () => new DrumVoice());
  private rootPatch: RootPatch | undefined;
  private drumPatch: DrumPatch | undefined;
  private noteCount = 0;
  private seed = 1;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<InMessage>) => {
      const msg = e.data;
      if (msg.type === 'patches') {
        this.rootPatch = msg.root;
        this.drumPatch = msg.drum;
        this.seed = msg.seed >>> 0;
        return;
      }
      const startFrame = Math.max(0, Math.round(msg.when * sampleRate));
      const note: QueuedNote = { ...msg, startFrame };
      // Sorted insertion keeps process() cheap.
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
      // Render everything up to this onset, then start the voice.
      this.renderVoices(l, r, cursor, offset);
      cursor = offset;
      this.startNote(note);
    }
    this.renderVoices(l, r, cursor, l.length);
    return true;
  }

  private renderVoices(l: Float32Array, r: Float32Array, from: number, to: number): void {
    if (from >= to) return;
    for (const v of this.strings) if (v.active) v.render(l, r, from, to);
    for (const v of this.drums) if (v.active) v.render(l, r, from, to);
  }

  private startNote(note: QueuedNote): void {
    this.noteCount += 1;
    const rng = new WorkletRng((this.seed ^ Math.imul(this.noteCount, 0x9e3779b1)) >>> 0);

    if (note.spirit === 'root' && this.rootPatch && note.midi !== undefined) {
      const voice = this.claim(this.strings);
      const freq = 440 * Math.pow(2, (note.midi - 69) / 12);
      voice.start(freq, note.velocity, Math.round(note.duration * sampleRate), this.rootPatch, rng);
      return;
    }
    if (note.spirit === 'drum' && this.drumPatch) {
      const kind =
        note.articulation === 'snare' ? 'snare' : note.articulation === 'tom' ? 'tom' : 'kick';
      this.claim(this.drums).start(kind, note.velocity, this.drumPatch, rng);
    }
  }

  /** A free voice, or the oldest one stolen with a fade. */
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
