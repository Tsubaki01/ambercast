import type { SecretsProvider } from '../../src/ports/system.js';

/**
 * Creates a secret provider from a scenario-local reference map.
 *
 * Copying the map makes the provider's arranged state independent of later
 * fixture mutation and preserves the distinction between a missing value and
 * an intentionally empty secret.
 *
 * @param secrets - Reference-to-value fixtures available to this provider.
 * @returns A synchronous lookup provider with no shared module state.
 */
export function createFakeSecretsProvider(secrets: ReadonlyMap<string, string>): SecretsProvider {
  const configuredSecrets = new Map(secrets);

  return {
    resolve(ref: string): string | undefined {
      return configuredSecrets.get(ref);
    },
  };
}
