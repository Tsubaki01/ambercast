import type { SecretsProvider } from '../../src/ports/system.js';

export function createFakeSecretsProvider(_secrets: ReadonlyMap<string, string>): SecretsProvider {
  return {
    resolve(_ref: string): string | undefined {
      throw new Error('not implemented');
    },
  };
}
