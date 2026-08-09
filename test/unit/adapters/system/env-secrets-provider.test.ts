import { describe, expect, it } from 'vitest';
import { createEnvSecretsProvider } from '../../../../src/adapters/system/env-secrets-provider.js';
import { registerSecretsProviderContract } from '../../../contracts/secrets-provider.contract.js';

registerSecretsProviderContract({
  createSecrets: (known) => createEnvSecretsProvider({
    AMBERCAST_SECRET_PRODUCTION_TOKEN: known.value,
  }),
});

describe('createEnvSecretsProvider()', () => {
  it.each([
    ['{{secrets.a}}', 'AMBERCAST_SECRET_A'],
    ['{{secrets.a.b}}', 'AMBERCAST_SECRET_A_B'],
    ['{{secrets.a.b.c}}', 'AMBERCAST_SECRET_A_B_C'],
    ['{{secrets.api_v2.tenant_42.key}}', 'AMBERCAST_SECRET_API_V2_TENANT_42_KEY'],
  ])('maps %s to %s', (ref, environmentName) => {
    const secrets = createEnvSecretsProvider({ [environmentName]: environmentName });

    expect(secrets.resolve(ref)).toBe(environmentName);
  });

  it('resolves a known environment variable value', () => {
    const secrets = createEnvSecretsProvider({ AMBERCAST_SECRET_EMAIL_PASSWORD: 'correct horse battery staple' });

    expect(secrets.resolve('{{secrets.email.password}}')).toBe('correct horse battery staple');
  });

  it('returns undefined when the mapped environment variable is absent', () => {
    const secrets = createEnvSecretsProvider({});

    expect(secrets.resolve('{{secrets.email.password}}')).toBeUndefined();
  });

  it('preserves an empty-string environment variable value', () => {
    const secrets = createEnvSecretsProvider({ AMBERCAST_SECRET_EMAIL_PASSWORD: '' });

    expect(secrets.resolve('{{secrets.email.password}}')).toBe('');
  });

  it('uses an injected environment record instead of the real process environment', () => {
    const ref = '{{secrets.issue_80.override_seam}}';
    const environmentName = 'AMBERCAST_SECRET_ISSUE_80_OVERRIDE_SEAM';
    const processValue = createEnvSecretsProvider().resolve(ref);
    const injectedValue = processValue === 'injected-value' ? 'injected-value-2' : 'injected-value';

    const secrets = createEnvSecretsProvider({ [environmentName]: injectedValue });

    expect(secrets.resolve(ref)).toBe(injectedValue);
    expect(secrets.resolve(ref)).not.toBe(processValue);
  });
});
