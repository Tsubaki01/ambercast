/*
 * Adapts the process environment to the secret-resolution boundary.
 *
 * Keeping the reference-to-environment-name translation here lets the rest of
 * the application deal in secret references without coupling its policy to
 * host-specific variable names. Secret values remain outside generated
 * artifacts and are looked up only when a consumer needs one.
 */

import type { SecretsProvider } from '#ports/system.js';

/**
 * Creates a secret provider backed by environment variables.
 *
 * @param env - Optional environment record to read instead of the current
 * process environment.
 * @returns A provider that resolves `{{secrets.a.b}}` through
 * `AMBERCAST_SECRET_A_B`: it replaces dots with underscores and uppercases
 * the reference segments.
 *
 * @remarks
 * With no override, the provider reads `process.env` at the real system
 * boundary. That is intentionally not described as hermetic: the process
 * environment is ambient mutable state. The override exists so a unit test
 * can supply a fixed record without mutating that state; production
 * composition leaves it absent.
 */
export function createEnvSecretsProvider(env?: NodeJS.ProcessEnv): SecretsProvider {
  return {
    resolve(ref: string): string | undefined {
      const name = ref.slice('{{secrets.'.length, -'}}'.length).replaceAll('.', '_').toUpperCase();

      return (env ?? process.env)[`AMBERCAST_SECRET_${name}`];
    },
  };
}
