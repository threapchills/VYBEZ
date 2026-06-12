import { describe, expect, it } from 'vitest';
import {
  BPM_MAX,
  BPM_MIN,
  SLOTS_PER_BAR,
  barOfSlot,
  isStrongBeat,
  secondsPerBeat,
  secondsPerSlot,
  slotInBar,
  snapBpm,
} from './time';

describe('time', () => {
  it('one bar is sixteen slots', () => {
    expect(SLOTS_PER_BAR).toBe(16);
  });

  it('converts BPM to seconds', () => {
    expect(secondsPerBeat(60)).toBe(1);
    expect(secondsPerSlot(60)).toBe(0.25);
    expect(secondsPerBeat(120)).toBe(0.5);
  });

  it('maps slots to bars', () => {
    expect(barOfSlot(0)).toBe(0);
    expect(barOfSlot(15)).toBe(0);
    expect(barOfSlot(16)).toBe(1);
    expect(slotInBar(17)).toBe(1);
  });

  it('marks beats one and three as strong', () => {
    expect(isStrongBeat(0)).toBe(true);
    expect(isStrongBeat(8)).toBe(true);
    expect(isStrongBeat(4)).toBe(false);
    expect(isStrongBeat(16)).toBe(true);
  });

  it('snaps BPM to censer notches and clamps the range', () => {
    expect(snapBpm(61)).toBe(60);
    expect(snapBpm(62)).toBe(64);
    expect(snapBpm(10)).toBe(BPM_MIN);
    expect(snapBpm(200)).toBe(BPM_MAX);
    expect(snapBpm(92)).toBe(92);
  });
});
