import { describe, expect, it } from 'vitest';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';

describe('createFixedClock', () => {
  it('returns the configured values repeatedly', () => {
    const fixed = new Date('2026-08-03T12:34:56.789Z');
    const clock = createFixedClock(fixed, 1234);

    expect(clock.now()).toEqual(fixed);
    expect(clock.now()).toEqual(fixed);
    expect(clock.monotonicMs()).toBe(1234);
    expect(clock.monotonicMs()).toBe(1234);
  });

  it('returns defensive Date copies rather than a shared mutable reference', () => {
    const clock = createFixedClock(new Date('2026-08-03T12:34:56.789Z'), 0);
    const first = clock.now();
    const second = clock.now();

    expect(first).not.toBe(second);
    first.setUTCFullYear(1999);
    expect(second.toISOString()).toBe('2026-08-03T12:34:56.789Z');
    expect(clock.now().toISOString()).toBe('2026-08-03T12:34:56.789Z');
  });

  it('keeps distinct fixed values isolated between instances', () => {
    const first = createFixedClock(new Date('2026-01-01T00:00:00.000Z'), 1);
    const second = createFixedClock(new Date('2026-02-01T00:00:00.000Z'), 2);

    expect(first.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(second.now().toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(first.monotonicMs()).toBe(1);
    expect(second.monotonicMs()).toBe(2);
  });
});
