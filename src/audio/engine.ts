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

    const node = new AudioWorkletNode(ctx, 'vybez-core', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node = node;

    node.connect(this.buildBus(ctx));

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

    bus.subscribe('note', (e) => {
      if (this.muted.has(e.spirit)) return;
      if (this.solo.size > 0 && !this.solo.has(e.spirit)) return;
      this.node?.port.postMessage({ type: 'note', ...e, when: e.time });
    });

    // The fire opens the master tone; the talismans morph each voice's timbre;
    // the wind drives the World bed.
    bus.subscribe('control', (e) => {
      if (e.target === 'fire') {
        this.setToneOpenness((e.value - 0.35) / 0.65);
      } else if (e.target === 'wind') {
        this.node?.port.postMessage({ type: 'world', wind: Math.round(e.value) });
      } else if (e.target.startsWith('timbre:')) {
        this.setTimbre(e.target.slice('timbre:'.length) as SpiritId, e.value);
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
        // Full table sweep, breath from pure to airy, vibrato arriving late.
        this.setPatchParam('voice', 'morph', lerp(0.0, 1.0));
        this.setPatchParam('voice', 'breath', lerp(0.0, 0.32));
        this.setPatchParam('voice', 'vibratoCents', lerp(0, 20));
        this.setPatchParam('voice', 'release', lerp(0.05, 0.4));
        break;
      case 'echo':
        // From dark, breathy bowing to a bright, pressed, singing tone.
        this.setPatchParam('echo', 'brightness', lerp(0.08, 1.0));
        this.setPatchParam('echo', 'pressure', lerp(0.3, 0.95));
        break;
      case 'rattle':
        // Woody and dark to glassy and ringing; strike position roams.
        this.setPatchParam('rattle', 'position', lerp(0.04, 0.62));
        this.setPatchParam('rattle', 'dampTilt', lerp(0.96, 0.52));
        this.setPatchParam('rattle', 'hardness', lerp(0.25, 1.0));
        break;
      case 'spinner':
        this.setPatchParam('spinner', 'position', lerp(0.03, 0.6));
        this.setPatchParam('spinner', 'dampTilt', lerp(0.95, 0.5));
        this.setPatchParam('spinner', 'hardness', lerp(0.25, 0.95));
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

  /** Saturation -> tone -> dry + fog -> compressor -> soft clip -> out. */
  private buildBus(ctx: AudioContext): AudioNode {
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

    const fog = ctx.createConvolver();
    fog.buffer = this.generateImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.28;

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
    makeup.gain.value = 0.6;

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
    return saturation;
  }

  /** Seeded noise under a ~3.5 s exponential decay with a dark lowpass tilt. */
  private generateImpulse(ctx: AudioContext): AudioBuffer {
    const seconds = 3.5;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    const irRng = this.rng.fork('impulse');
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < length; i++) {
        const t = i / ctx.sampleRate;
        const noise = irRng.range(-1, 1);
        lp += 0.12 * (noise - lp);
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
