import { describe, expect, it } from 'vitest';
import {
  isAllowedSecretSinkOrigin,
  originOf,
  resolveSecretSinkPolicy,
  type SecretSinkPolicy,
} from '#core/secrets/sink-policy.js';
import type { TargetDefinition } from '#core/ir/schema.js';

const SECRET_REF = '{{secrets.app.password}}';
const OTHER_SECRET_REF = '{{secrets.app.apiKey}}';
const TARGET: TargetDefinition = { baseUrl: 'https://app.example.test', browser: 'chromium' };

describe('originOf', () => {
  it('normalizes host case and default ports while retaining non-default ports', () => {
    expect(originOf('https://EXAMPLE.com')).toBe('https://example.com');
    expect(originOf('https://host:443')).toBe('https://host');
    expect(originOf('http://host:80')).toBe('http://host');
    expect(originOf('https://host:8443')).toBe('https://host:8443');
  });

  it('returns undefined for non-HTTP(S) and unparsable URLs', () => {
    expect(originOf('ftp://host')).toBeUndefined();
    expect(originOf('not a url')).toBeUndefined();
  });

  it('mirrors the platform origin for a trailing-dot host instead of adding a bespoke rule', () => {
    expect(originOf('https://example.com.')).toBe(new URL('https://example.com.').origin);
  });
});

describe('resolveSecretSinkPolicy', () => {
  it('defaults to the base URL origin when no mapping exists', () => {
    expect(resolveSecretSinkPolicy(TARGET, SECRET_REF)).toEqual({
      secretRef: SECRET_REF,
      allowedOrigins: ['https://app.example.test'],
      source: 'base-url-default',
    });
  });

  it('defaults per secret reference when only another secret has a mapping', () => {
    expect(resolveSecretSinkPolicy({
      ...TARGET,
      secretSinkOrigins: { [OTHER_SECRET_REF]: ['https://idp.example.test'] },
    }, SECRET_REF)).toEqual({
      secretRef: SECRET_REF,
      allowedOrigins: ['https://app.example.test'],
      source: 'base-url-default',
    });
  });

  it('normalizes a configured mapping and replaces rather than augments the base URL default', () => {
    const policy = resolveSecretSinkPolicy({
      ...TARGET,
      secretSinkOrigins: {
        [SECRET_REF]: [
          'https://IDP.example.test:443',
          'http://first.example.test:80',
          'https://idp.example.test',
          'https://second.example.test:8443',
        ],
      },
    }, SECRET_REF);

    expect(policy).toEqual({
      secretRef: SECRET_REF,
      allowedOrigins: [
        'https://idp.example.test',
        'http://first.example.test',
        'https://second.example.test:8443',
      ],
      source: 'configured',
    });
    expect(policy.allowedOrigins).not.toContain('https://app.example.test');
  });

  it('preserves an explicit empty mapping as a configured deny-everywhere policy', () => {
    expect(resolveSecretSinkPolicy({
      ...TARGET,
      secretSinkOrigins: { [SECRET_REF]: [] },
    }, SECRET_REF)).toEqual({
      secretRef: SECRET_REF,
      allowedOrigins: [],
      source: 'configured',
    });
  });

  it('fails closed when a hand-built target bypasses schema validation with an unnormalizable origin', () => {
    const bypassedSchema = {
      ...TARGET,
      secretSinkOrigins: { [SECRET_REF]: ['https://idp.example.test', 'not a url'] },
    } as unknown as TargetDefinition;

    expect(resolveSecretSinkPolicy(bypassedSchema, SECRET_REF)).toEqual({
      secretRef: SECRET_REF,
      allowedOrigins: [],
      source: 'configured',
    });

    const bypassedDefaultSchema = {
      ...TARGET,
      baseUrl: 'not a URL',
    } as unknown as TargetDefinition;

    expect(resolveSecretSinkPolicy(bypassedDefaultSchema, SECRET_REF)).toEqual({
      secretRef: SECRET_REF,
      allowedOrigins: [],
      source: 'base-url-default',
    });
  });
});

describe('isAllowedSecretSinkOrigin', () => {
  const policy: SecretSinkPolicy = {
    secretRef: SECRET_REF,
    allowedOrigins: ['https://idp.example.test'],
    source: 'configured',
  };

  it('allows a current URL whose normalized origin is listed', () => {
    expect(isAllowedSecretSinkOrigin(policy, 'https://IDP.example.test:443/login')).toBe(true);
  });

  it('rejects absent origins and an explicit deny-everywhere policy', () => {
    expect(isAllowedSecretSinkOrigin(policy, 'https://app.example.test/login')).toBe(false);
    expect(isAllowedSecretSinkOrigin({ ...policy, allowedOrigins: [] }, 'https://idp.example.test/login')).toBe(false);
  });

  it('rejects non-normalizable current URLs even if invalid data is cast into the policy', () => {
    const invalidPolicy = {
      ...policy,
      allowedOrigins: [undefined],
    } as unknown as SecretSinkPolicy;

    expect(isAllowedSecretSinkOrigin(policy, 'ftp://idp.example.test')).toBe(false);
    expect(isAllowedSecretSinkOrigin(invalidPolicy, 'not a url')).toBe(false);
  });
});
