import { describe, expect, it } from 'vitest';
import type { Clock } from '../../src/ports/system.js';

export interface ClockContractHarness {
  createClock(): Clock | Promise<Clock>;
  dispose?(): void | Promise<void>;
}

export function registerClockContract(harness: ClockContractHarness): void {
  describe('Clock contract', () => {
    it('returns a non-decreasing monotonic reading', async () => {
      try {
        const clock = await harness.createClock();

        const first = clock.monotonicMs();
        const second = clock.monotonicMs();

        expect(second).toBeGreaterThanOrEqual(first);
      } finally {
        await harness.dispose?.();
      }
    });

    it('returns a Date for the current wall-clock instant', async () => {
      try {
        const clock = await harness.createClock();

        expect(clock.now()).toBeInstanceOf(Date);
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
