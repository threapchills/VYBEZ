import { bus } from '../core/bus';
import type { SpiritId } from '../core/contracts';
import type { Rng } from '../core/rng';
import breathPatch from './patches/breath.json';
import drumPatch from './patches/drum.json';
import echoPatch from './patches/echo.json';
import rattlePatch from './patches/rattle.json';
import rootPatch from './patches/root.json';
import spinnerPatch from './patches/spinner.json';
import voicePatch from './patches/voice.json';
import { bakeWavetables } from './tables';
import workletUrl from './worklets/vybez-core.worklet.ts?worker&url';

// The engine owns the AudioContext and the master bus; the conductor owns the
// music. Chain per the handoff: worklet -> tape saturation -> master tone
// filter -> dry + generated-IR fog -> bus compressor -> soft clip -> out.

/** The per-spirit patch slots the worklet renders; the dev rig edits these. */
export type PatchKey =
  | 'root'
  | 'drum'
  | 'rattle'
  | 'shaker'
  | 'spinner'
  | 'voice'
  | 'echo'
  | 'breath';

export class Engine {
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private toneFilter: BiquadFilterNode | undefined;
  private masterGain: GainNode | undefined;
  // The delay bank, tempo-synced and wind-swirled.
  private pingL: DelayNode | undefined;
  private pingR: DelayNode | undefined;
  private longDelay: DelayNode | undefined;
  private pingFbA: GainNode | undefined;
  private pingFbB: GainNode | undefined;
  private longFb: GainNode | undefined;
  private longTone: BiquadFilterNode | undefined;
  private static readonly MASTER_LEVEL = 0.82;

  /** Live patch slots, mutated by the dev rig and pushed to the worklet. */
  private readonly patches: Record<PatchKey, Record<string, number>>;
  /** Dev-rig solo and mute sets; empty solo means everyone sounds. */
  private readonly solo = new Set<SpiritId>();
  private readonly muted = new Set<SpiritId>();

  constructor(private readonly rng: Rng) {
    this.patches = {
      root: { ...rootPatch, detuneCents: rng.range(-5, 5) },
      drum: { ...drumPatch },
      rattle: { ...rattlePatch.modal } as unknown as Record<string, number>,
      shaker: { ...rattlePatch.shaker },
      spinner: { ...spinnerPatch } as unknown as Record<string, number>,
      voice: { ...voicePatch, detuneCents: rng.range(-5, 5) },
      echo: { ...echoPatch, detuneCents: rng.range(-5, 5) },
      breath: { ...breathPatch },
    };
  }

  get started(): boolean {
    return this.ctx !== undefined && this.ctx.state === 'running';
  }

  /** The conductor's clock; only meaningful once unlocked. */
  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Diagnostic access for QA probes. */
  get audioContext(): AudioContext | undefined {
    return this.ctx;
  }
  get masterNode(): GainNode | undefined {
    return this.masterGain;
  }

  /** Must be called from a user gesture: the first tap on the fire. */
  async unlock(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.resume();
    await ctx.audioWorklet.addModule(workletUrl);

    // Four outputs: the dry mix and three per-spirit send buses (cavern
    // shimmer, near room, delay bank). Send levels live in the patches.
    const node = new AudioWorkletNode(ctx, 'vybez-core', {
      numberOfInputs: 0,
      numberOfOutputs: 4,
      outputChannelCount: [2, 2, 2, 2],
    });
    this.node = node;

    const fx = this.buildBus(ctx);
    node.connect(fx.input, 0);
    node.connect(fx.revA, 1);
    node.connect(fx.revB, 2);
    node.connect(fx.dly, 3);

    // Session-baked material: the seed bakes the wavetable bank. Covenant
    // rule 5's resting detune was chosen in the constructor so the dev rig and
    // the worklet agree on the starting patch.
    const tables = bakeWavetables(this.rng.fork('tables'));
    node.port.postMessage(
      {
        type: 'patches',
        seed: Math.floor(this.rng.next() * 0xffffffff),
        root: this.patches.root,
        drum: this.patches.drum,
        rattle: this.patches.rattle,
        shaker: this.patches.shaker,
        spinner: this.patches.spinner,
        voice: this.patches.voice,
        echo: this.patches.echo,
        breath: this.patches.breath,
        tables,
      },
      [tables.data.buffer],
    );

    // The World bed starts on the default breeze; the banner drives it from here.
    node.port.postMessage({ type: 'world', wind: 1 });

    bus.subscribe('note', (e) => {
      if (this.muted.has(e.spirit)) return;
      if (this.solo.size > 0 && !this.solo.has(e.spirit)) return;
      this.node?.port.postMessage({ type: 'note', ...e, when: e.time });
    });

    // The fire opens the master tone; the talismans morph each voice's timbre;
    // the wind drives the World bed.
    bus.subscribe('control', (e) => {
      if (e.target === 'fire') {
        const norm = (e.value - 0.35) / 0.65;
        this.setToneOpenness(norm);
        // A high fire pulls the valley close and dry; a dying one recedes
        // into the cavern.
        this.node?.port.postMessage({ type: 'space', fire: Math.max(0, Math.min(1, norm)) });
      } else if (e.target === 'wind') {
        const w = Math.round(e.value);
        this.node?.port.postMessage({ type: 'world', wind: w });
        this.setWindSwirl(w);
      } else if (e.target === 'censer') {
        this.setTempo(e.value);
      } else if (e.target === 'strum') {
        // Every touch on the sky leaves the space shimmering a while longer.
        this.node?.port.postMessage({ type: 'glow' });
      } else if (e.target === 'moon') {
        // The lead glides into the new key for a few seconds.
        this.node?.port.postMessage({ type: 'glide' });
      } else if (e.target.startsWith('timbre:')) {
        this.setTimbre(e.target.slice('timbre:'.length) as SpiritId, e.value);
      } else if (e.target.startsWith('space:')) {
        this.setSpace(e.target.slice('space:'.length) as SpiritId, e.value);
      }
    });

    // Mobile may suspend audio when backgrounded; resume cleanly on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.state === 'suspended') {
        void ctx.resume();
      }
    });
  }

  /** The mute icon flips this; a short ramp avoids a click. */
  setMasterMuted(muted: boolean): void {
    const g = this.masterGain;
    if (!g || !this.ctx) return;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(muted ? 0 : Engine.MASTER_LEVEL, t + 0.05);
  }

  /** The delay bank locks to the censer: a dotted eighth and a whole bar. */
  setTempo(bpm: number): void {
    const spb = 60 / Math.max(40, Math.min(200, bpm));
    const t = this.ctx?.currentTime ?? 0;
    this.pingL?.delayTime.setTargetAtTime(Math.min(4.5, 0.75 * spb), t, 0.15);
    this.pingR?.delayTime.setTargetAtTime(Math.min(4.5, 0.75 * spb), t, 0.15);
    this.longDelay?.delayTime.setTargetAtTime(Math.min(4.5, 4 * spb), t, 0.3);
  }

  /** The wind swirls the delays: still is tight, gale feeds back and darkens. */
  private setWindSwirl(wind: number): void {
    const w = Math.max(0, Math.min(2, wind));
    const t = this.ctx?.currentTime ?? 0;
    const fb = [0.3, 0.42, 0.55][w] ?? 0.42;
    this.pingFbA?.gain.setTargetAtTime(fb, t, 0.5);
    this.pingFbB?.gain.setTargetAtTime(fb, t, 0.5);
    this.longFb?.gain.setTargetAtTime([0.3, 0.45, 0.58][w] ?? 0.45, t, 0.5);
    this.longTone?.frequency.setTargetAtTime([2000, 2600, 3400][w] ?? 2600, t, 0.5);
  }

  /**
   * The space macro, drift's fourth dimension: one 0-to-1 input walks a spirit
   * from close and dry to far and washed by sweeping its send levels.
   */
  setSpace(spirit: SpiritId, t01: number): void {
    const t = Math.max(0, Math.min(1, t01));
    const key = spirit as PatchKey;
    if (!(key in this.patches)) return;
    this.setPatchParam(key, 'revA', 0.04 + t * 0.56);
    this.setPatchParam(key, 'dly', 0.05 + t * 0.45);
  }

  /** Open or close the master tone as the fire rises; phase 3 drives this. */
  setToneOpenness(open01: number): void {
    if (this.toneFilter) {
      const t = Math.max(0, Math.min(1, open01));
      this.toneFilter.frequency.value = 2200 + t * 11000;
    }
  }

  // --- dev rig surface ---

  /** A live snapshot of every patch slot, for the rig to render controls from. */
  patchSnapshot(): Record<PatchKey, Record<string, number>> {
    return structuredClone(this.patches);
  }

  /** Edit one patch parameter and push the whole slot to the worklet live. */
  setPatchParam(key: PatchKey, param: string, value: number): void {
    const patch = this.patches[key];
    if (!(param in patch)) return;
    patch[param] = value;
    this.node?.port.postMessage({ type: 'patch-update', key, patch });
  }

  /** Sound a single note now, for the rig's audition keys. */
  audition(spirit: SpiritId, midi: number, articulation?: string): void {
    if (!this.ctx) return;
    const note = {
      type: 'note' as const,
      spirit,
      when: this.ctx.currentTime + 0.02,
      midi,
      velocity: 0.85,
      duration: 0.8,
      ...(articulation ? { articulation } : {}),
    };
    this.node?.port.postMessage(note);
  }

  /**
   * The talisman macro: one 0-to-1 input sweeps each voice's character along a
   * curve through several patch parameters. A first pass of the curves, to be
   * dialled in by ear with the rig; every point along the travel stays musical.
   */
  setTimbre(spirit: SpiritId, t01: number): void {
    const t = Math.max(0, Math.min(1, t01));
    const lerp = (a: number, b: number): number => a + (b - a) * t;
    // Macros sweep wide on purpose: each spirit should travel a vast range of
    // character across one talisman drag, every point of it musical.
    switch (spirit) {
      case 'voice':
        // Full table sweep, breath from pure to airy, vibrato arriving late;
        // the unison widens and the tremolo deepens toward the bright end.
        this.setPatchParam('voice', 'morph', lerp(0.0, 1.0));
        this.setPatchParam('voice', 'breath', lerp(0.0, 0.32));
        this.setPatchParam('voice', 'vibratoCents', lerp(0, 20));
        this.setPatchParam('voice', 'release', lerp(0.05, 0.4));
        this.setPatchParam('voice', 'unison', lerp(0.15, 0.9));
        this.setPatchParam('voice', 'trem', lerp(0.02, 0.28));
        break;
      case 'echo':
        // From dark, breathy bowing to a bright, pressed, singing tone.
        this.setPatchParam('echo', 'brightness', lerp(0.08, 1.0));
        this.setPatchParam('echo', 'pressure', lerp(0.3, 0.95));
        this.setPatchParam('echo', 'trem', lerp(0.05, 0.35));
        break;
      case 'rattle':
        // Woody and dark to glassy and ringing; the ombak pair beats harder.
        this.setPatchParam('rattle', 'position', lerp(0.04, 0.62));
        this.setPatchParam('rattle', 'dampTilt', lerp(0.96, 0.52));
        this.setPatchParam('rattle', 'hardness', lerp(0.25, 1.0));
        this.setPatchParam('rattle', 'pair', lerp(0.05, 0.95));
        break;
      case 'spinner':
        this.setPatchParam('spinner', 'position', lerp(0.03, 0.6));
        this.setPatchParam('spinner', 'dampTilt', lerp(0.95, 0.5));
        this.setPatchParam('spinner', 'hardness', lerp(0.25, 0.95));
        this.setPatchParam('spinner', 'pair', lerp(0.05, 0.95));
        break;
      case 'breath':
        // From a distant, closed pipe to an open, chiffy, present blow.
        this.setPatchParam('breath', 'cutoff', lerp(0.08, 0.98));
        this.setPatchParam('breath', 'chiff', lerp(0.05, 1.0));
        break;
      case 'root':
        // Sub-heavy and dark to a bright, woody pluck.
        this.setPatchParam('root', 'brightness', lerp(0.12, 0.95));
        this.setPatchParam('root', 'subMix', lerp(0.6, 0.12));
        break;
      case 'drum':
        this.setPatchParam('drum', 'tone', lerp(0.08, 0.95));
        this.setPatchParam('drum', 'decay', lerp(0.3, 0.9));
        break;
    }
  }

  setSolo(spirit: SpiritId, on: boolean): void {
    if (on) this.solo.add(spirit);
    else this.solo.delete(spirit);
  }

  setMuted(spirit: SpiritId, on: boolean): void {
    if (on) this.muted.add(spirit);
    else this.muted.delete(spirit);
  }

  /**
   * The main path: saturation -> tone -> dry + fog glue -> compressor -> soft
   * clip -> out. Beside it, three send returns join at the compressor: a long
   * seeded cavern, a short near room, and the tempo-synced delay bank.
   */
  private buildBus(ctx: AudioContext): {
    input: AudioNode;
    revA: AudioNode;
    revB: AudioNode;
    dly: AudioNode;
  } {
    const saturation = ctx.createWaveShaper();
    // Gentle warmth: a low drive so the stage barely lifts low-level signal and
    // only rounds the peaks. A high drive here was secretly a 1.6x booster that
    // slammed the whole bus into the limiter.
    saturation.curve = tanhCurve(0.8);
    saturation.oversample = '2x';

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 9500;
    tone.Q.value = 0.4;
    this.toneFilter = tone;

    const dry = ctx.createGain();
    dry.gain.value = 0.85;

    // The fog stays as quiet glue; the featured space is per-spirit now.
    const fog = ctx.createConvolver();
    fog.buffer = this.generateImpulse(ctx, 3.5, 0.12, 'impulse');
    const wet = ctx.createGain();
    wet.gain.value = 0.15;

    // Gentle glue: catch the peaks, hold the spirits together, never pump.
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 20;
    compressor.ratio.value = 2.5;
    compressor.attack.value = 0.012;
    compressor.release.value = 0.18;

    // Attenuate into the soft limiter so the mix keeps its dynamics: peaks are
    // caught, not crushed, and quiet moments stay quiet enough to hear a change.
    const makeup = ctx.createGain();
    makeup.gain.value = 0.52;

    const clip = ctx.createWaveShaper();
    clip.curve = tanhCurve(1);
    clip.oversample = '2x';

    const master = ctx.createGain();
    master.gain.value = Engine.MASTER_LEVEL;
    this.masterGain = master;

    saturation.connect(tone);
    tone.connect(dry);
    tone.connect(fog);
    fog.connect(wet);
    dry.connect(compressor);
    wet.connect(compressor);
    compressor.connect(makeup);
    makeup.connect(clip);
    clip.connect(master);
    master.connect(ctx.destination);

    // The send returns feed the same tape stage as the dry mix: one shared
    // saturation rounds every transient (nothing reaches the clip raw), and
    // the fire's tone filter darkens the wash as the hearth dies.

    // Send return A: the cavern, long and shimmering; breath and echo live here.
    const revA = ctx.createConvolver();
    revA.buffer = this.generateImpulse(ctx, 5.5, 0.22, 'ir-cavern');
    const revAOut = ctx.createGain();
    revAOut.gain.value = 0.42;
    revA.connect(revAOut);
    revAOut.connect(saturation);

    // Send return B: the near room, short and dark; the drums share this air.
    const revB = ctx.createConvolver();
    revB.buffer = this.generateImpulse(ctx, 1.3, 0.09, 'ir-room');
    const revBOut = ctx.createGain();
    revBOut.gain.value = 0.4;
    revB.connect(revBOut);
    revBOut.connect(saturation);

    // The delay bank: highpassed in, a dotted-eighth ping-pong pair and a
    // whole-bar dark tap, feedback in the wind's hands.
    const dlyIn = ctx.createBiquadFilter();
    dlyIn.type = 'highpass';
    dlyIn.frequency.value = 320;
    dlyIn.Q.value = 0.5;
    const dlyOut = ctx.createGain();
    dlyOut.gain.value = 0.42;
    dlyOut.connect(saturation);

    const spb = 60 / 76;
    const pingL = ctx.createDelay(5);
    const pingR = ctx.createDelay(5);
    pingL.delayTime.value = 0.75 * spb;
    pingR.delayTime.value = 0.75 * spb;
    const fbA = ctx.createGain();
    const fbB = ctx.createGain();
    fbA.gain.value = 0.42;
    fbB.gain.value = 0.42;
    const panL = ctx.createStereoPanner();
    const panR = ctx.createStereoPanner();
    panL.pan.value = -0.6;
    panR.pan.value = 0.6;
    dlyIn.connect(pingL);
    pingL.connect(panL);
    panL.connect(dlyOut);
    pingL.connect(fbA);
    fbA.connect(pingR);
    pingR.connect(panR);
    panR.connect(dlyOut);
    pingR.connect(fbB);
    fbB.connect(pingL);

    const longDelay = ctx.createDelay(5);
    longDelay.delayTime.value = 4 * spb;
    const longTone = ctx.createBiquadFilter();
    longTone.type = 'lowpass';
    longTone.frequency.value = 2600;
    const longFb = ctx.createGain();
    longFb.gain.value = 0.45;
    const longOut = ctx.createGain();
    longOut.gain.value = 0.35;
    dlyIn.connect(longDelay);
    longDelay.connect(longTone);
    longTone.connect(longFb);
    longFb.connect(longDelay);
    longTone.connect(longOut);
    longOut.connect(dlyOut);

    this.pingL = pingL;
    this.pingR = pingR;
    this.longDelay = longDelay;
    this.pingFbA = fbA;
    this.pingFbB = fbB;
    this.longFb = longFb;
    this.longTone = longTone;

    return { input: saturation, revA, revB, dly: dlyIn };
  }

  /** Seeded noise under an exponential decay with a lowpass tilt: a space. */
  private generateImpulse(
    ctx: AudioContext,
    seconds: number,
    lpCoef: number,
    label: string,
  ): AudioBuffer {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    const irRng = this.rng.fork(label);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / ctx.sampleRate;
        const noise = irRng.range(-1, 1);
        lp += lpCoef * (noise - lp);
        // -60 dB at the tail's end.
        data[i] = lp * Math.exp((-6.91 * t) / seconds);
      }
    }
    return buffer;
  }
}

function tanhCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}
