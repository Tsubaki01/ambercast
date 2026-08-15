import type { TargetDefinition } from '#core/ir/schema.js';
import type { SecretSinkPolicy } from '#core/secrets/sink-policy.js';

/**
 * Builds the default secret-sink policy for a target fixture.
 *
 * Tests use this policy when a secret has no explicit origin override, so its
 * only permitted sink is the target's normalized base URL origin.
 *
 * @param secretRef - Reference naming the secret covered by the policy.
 * @param target - Target fixture whose base URL supplies the default origin.
 * @returns The policy produced by the target's default-origin rule.
 */
export function baseUrlSecretPolicy(
  secretRef: string,
  target: Pick<TargetDefinition, 'baseUrl'>,
): SecretSinkPolicy {
  return {
    secretRef,
    allowedOrigins: [new URL(target.baseUrl).origin],
    source: 'base-url-default',
  };
}
