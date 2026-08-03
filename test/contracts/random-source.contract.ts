import { describe, expect, it } from 'vitest';
import type { RandomSource } from '../../src/ports/system.js';

export interface RandomSourceContractHarness {
  createRandom(): RandomSource | Promise<RandomSource>;
  dispose?(): void | Promise<void>;
}

export function registerRandomSourceContract(harness: RandomSourceContractHarness): void {
  describe('RandomSource contract', () => {
    it('returns a UUID in RFC 4122 text form', async () => {
      try {
        const random = await harness.createRandom();

        expect(random.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      } finally {
        await harness.dispose?.();
      }
    });

    it('returns a fractional value in the unit interval', async () => {
      try {
        const random = await harness.createRandom();
        const value = random.float();

        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
