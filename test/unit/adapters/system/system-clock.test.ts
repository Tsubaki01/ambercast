import { describe, expect, it, vi } from 'vitest';
import { createSystemClock } from '../../../../src/adapters/system/system-clock.js';
import { registerClockContract } from '../../../contracts/clock.contract.js';

registerClockContract({
  createClock: createSystemClock,
});

describe('createSystemClock()', () => {
  it('returns a wall-clock instant bracketed by real system time', () => {
    const clock = createSystemClock();
    const before = Date.now();
    const instant = clock.now();
    const after = Date.now();

    expect(instant).toBeInstanceOf(Date);
    expect(instant.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(instant.getTime()).toBeLessThanOrEqual(after + 5_000);
  });

  it('creates a distinct fresh Date for each wall-clock reading', () => {
    const clock = createSystemClock();
    const first = clock.now();
    const second = clock.now();

    expect(first).not.toBe(second);
    expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  });

  it('returns non-decreasing numeric monotonic readings from successive calls', () => {
    const clock = createSystemClock();
    const first = clock.monotonicMs();
    const second = clock.monotonicMs();

    expect(first).toEqual(expect.any(Number));
    expect(second).toEqual(expect.any(Number));
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('delegates monotonic readings to the runtime performance clock', () => {
    const performanceNow = vi.spyOn(performance, 'now').mockReturnValue(12_345.678);

    try {
      const reading = createSystemClock().monotonicMs();

      expect(performanceNow).toHaveBeenCalledOnce();
      expect(reading).toBe(12_345.678);
    } finally {
      performanceNow.mockRestore();
    }
  });
});
