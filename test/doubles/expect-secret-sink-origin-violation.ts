import { expect } from 'vitest';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import type { SecretSinkPolicy } from '#core/secrets/sink-policy.js';

/**
 * Asserts that a rejected secret fill reports the policy that denied its origin.
 *
 * Adapter and use-case tests share the same public integrity-error contract:
 * the error remains classified as an integrity violation and exposes policy
 * metadata without exposing the materialized secret value.
 *
 * @param error - Rejection value produced by the attempted secret fill.
 * @param policy - Policy whose denied origin the error must report.
 */
export function expectSecretSinkOriginViolation(error: unknown, policy: SecretSinkPolicy): void {
  expect(error).toBeInstanceOf(IntegrityViolationError);
  if (!(error instanceof IntegrityViolationError)) {
    return;
  }

  expect({ kind: error.kind, exitCode: error.exitCode }).toStrictEqual({
    kind: 'integrity-violation',
    exitCode: 4,
  });
  expect(error.details).toStrictEqual({
    secretRef: policy.secretRef,
    allowedOrigins: policy.allowedOrigins,
    source: policy.source,
  });
}
