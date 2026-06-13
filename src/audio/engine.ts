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
export type PatchKey = 'root' | 'drum' | 'rattle' | 'shaker' | 'spinner' | 'voice' | 'echo' | 'breath';

export class Engine {
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;
  private toneFilter: BiquadFilterNode | undefined;

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

    // Mobile may suspend audio when backgrounded; resume cleanly on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.state === 'suspended') {
        void ctx.resume();
      }
    });
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
    saturation.curve = tanhCurve(1.4);
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

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.25;

    const clip = ctx.createWaveShaper();
    clip.curve = tanhCurve(1);
    clip.oversample = '2x';

    const master = ctx.createGain();
    master.gain.value = 0.9;

    saturation.connect(tone);
    tone.connect(dry);
    tone.connect(fog);
    fog.connect(wet);
    dry.connect(compressor);
    wet.connect(compressor);
    compressor.connect(clip);
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
