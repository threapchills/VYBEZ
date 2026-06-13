import { bus } from '../core/bus';
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

export class Engine {
  private ctx: AudioContext | undefined;
  private node: AudioWorkletNode | undefined;

  constructor(private readonly rng: Rng) {}

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

    // Session-baked material: the seed bakes the wavetable bank and chooses
    // each melodic voice's resting detune. Covenant rule 5 lives here.
    const tables = bakeWavetables(this.rng.fork('tables'));
    node.port.postMessage(
      {
        type: 'patches',
        seed: Math.floor(this.rng.next() * 0xffffffff),
        root: { ...rootPatch, detuneCents: this.rng.range(-5, 5) },
        drum: drumPatch,
        rattle: rattlePatch.modal,
        shaker: rattlePatch.shaker,
        spinner: spinnerPatch,
        voice: { ...voicePatch, detuneCents: this.rng.range(-5, 5) },
        echo: { ...echoPatch, detuneCents: this.rng.range(-5, 5) },
        breath: breathPatch,
        tables,
      },
      [tables.data.buffer],
    );

    bus.subscribe('note', (e) => {
      this.node?.port.postMessage({ type: 'note', ...e, when: e.time });
    });

    // Mobile may suspend audio when backgrounded; resume cleanly on return.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && ctx.state === 'suspended') {
        void ctx.resume();
      }
    });
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
