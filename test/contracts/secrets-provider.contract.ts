import { describe, expect, it } from 'vitest';
import type { SecretsProvider } from '../../src/ports/system.js';

export interface SecretsProviderContractHarness {
  createSecrets(known: { readonly ref: string; readonly value: string }): SecretsProvider | Promise<SecretsProvider>;
  dispose?(): void | Promise<void>;
}

const KNOWN_SECRET = { ref: '{{secrets.production.token}}', value: 'secret-value' };

export function registerSecretsProviderContract(harness: SecretsProviderContractHarness): void {
  describe('SecretsProvider contract', () => {
    it('returns the value for a known reference', async () => {
      try {
        const secrets = await harness.createSecrets(KNOWN_SECRET);

        expect(secrets.resolve(KNOWN_SECRET.ref)).toBe(KNOWN_SECRET.value);
      } finally {
        await harness.dispose?.();
      }
    });

    it('returns undefined for an unknown reference', async () => {
      try {
        const secrets = await harness.createSecrets(KNOWN_SECRET);

        expect(secrets.resolve('{{secrets.production.missing}}')).toBeUndefined();
      } finally {
        await harness.dispose?.();
      }
    });
  });
}
