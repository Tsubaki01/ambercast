import type { Clock } from '../../src/ports/system.js';

export function createFixedClock(_now: Date, _monotonicMs: number): Clock {
  return {
    now(): Date {
      throw new Error('not implemented');
    },
    monotonicMs(): number {
      throw new Error('not implemented');
    },
  };
}
