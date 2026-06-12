import { describe, expect, it } from 'vitest';
import { Bus } from './bus';
import type { NoteEvent } from './contracts';

describe('Bus', () => {
  it('delivers payloads to subscribers of the topic', () => {
    const bus = new Bus();
    const received: NoteEvent[] = [];
    bus.subscribe('note', (e) => received.push(e));
    const note: NoteEvent = { spirit: 'drum', time: 0, velocity: 0.8, duration: 0.1 };
    bus.publish('note', note);
    expect(received).toEqual([note]);
  });

  it('does not deliver across topics', () => {
    const bus = new Bus();
    let calls = 0;
    bus.subscribe('control', () => calls++);
    bus.publish('note', { spirit: 'root', time: 0, velocity: 1, duration: 1 });
    expect(calls).toBe(0);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new Bus();
    let calls = 0;
    const off = bus.subscribe('wake', () => calls++);
    bus.publish('wake', { spirit: 'voice', awake: true });
    off();
    bus.publish('wake', { spirit: 'voice', awake: false });
    expect(calls).toBe(1);
  });

  it('supports many subscribers on one topic', () => {
    const bus = new Bus();
    let a = 0;
    let b = 0;
    bus.subscribe('control', () => a++);
    bus.subscribe('control', () => b++);
    bus.publish('control', { target: 'fire', value: 1 });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
