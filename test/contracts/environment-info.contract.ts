import { describe, expect, it } from 'vitest';
import type { EnvironmentInfo } from '../../src/ports/system.js';

export interface EnvironmentInfoContractHarness {
  createEnvironment(isCI: boolean): EnvironmentInfo | Promise<EnvironmentInfo>;
  dispose?(): void | Promise<void>;
}

export function registerEnvironmentInfoContract(harness: EnvironmentInfoContractHarness): void {
  describe('EnvironmentInfo contract', () => {
    it.each([true, false])('returns the arranged CI value %s', async (isCI) => {
      try {
        const environment = await harness.createEnvironment(isCI);

        expect(environment.isCI()).toBe(isCI);
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
