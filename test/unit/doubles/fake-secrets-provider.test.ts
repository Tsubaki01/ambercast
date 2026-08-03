import { describe, expect, it } from 'vitest';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

describe('createFakeSecretsProvider', () => {
  it('resolves known references, including dotted names', () => {
    const secrets = createFakeSecretsProvider(new Map([
      ['{{secrets.production.api.token}}', 'token-value'],
    ]));

    expect(secrets.resolve('{{secrets.production.api.token}}')).toBe('token-value');
  });

  it('returns undefined for an unknown reference', () => {
    const secrets = createFakeSecretsProvider(new Map([['{{secrets.known}}', 'value']]));

    expect(secrets.resolve('{{secrets.unknown}}')).toBeUndefined();
  });

  it('preserves an intentionally empty secret value', () => {
    const secrets = createFakeSecretsProvider(new Map([['{{secrets.empty}}', '']]));

    expect(secrets.resolve('{{secrets.empty}}')).toBe('');
  });

  it('keeps separately created providers isolated', () => {
    const first = createFakeSecretsProvider(new Map([['{{secrets.shared}}', 'first']]));
    const second = createFakeSecretsProvider(new Map([['{{secrets.shared}}', 'second']]));

    expect(first.resolve('{{secrets.shared}}')).toBe('first');
    expect(second.resolve('{{secrets.shared}}')).toBe('second');
  });
});
