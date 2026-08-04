import { describe, expect, it } from 'vitest';
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

  it('returns non-decreasing numeric monotonic readings from successive calls', () => {
    const clock = createSystemClock();
    const first = clock.monotonicMs();
    const second = clock.monotonicMs();

    expect(first).toEqual(expect.any(Number));
    expect(second).toEqual(expect.any(Number));
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
