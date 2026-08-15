/*
 * Centralizes the secret-sink origin comparison predicate. Deterministic and
 * fresh-agentic dispatch apply it before resolving a value for a fill, while
 * trace replay applies it before resolving each replay entry's fill value as
 * that entry materializes. Trace priming resolves granted references earlier
 * only for whole-trace taint checks; it performs no browser action, and a
 * later per-entry denial remains an integrity failure that cannot fall back to
 * agentic execution. Chromium applies the same policy again immediately
 * before filling the page, so both checkpoints share one origin rule.
 */

import type { TargetDefinition } from '../ir/schema.js';

/**
 * A resolved origin policy for one secret at one browser target.
 *
 * @remarks
 * `allowedOrigins` is already normalized into a deduplicated,
 * order-preserving list of canonical `URL(...).origin` values, never raw
 * configuration strings. `source` distinguishes an explicit configuration
 * mapping from the implicit `baseUrl` default for diagnostics; an origin
 * rejection reports it alongside `secretRef` and `allowedOrigins`, while both
 * sources use identical enforcement. The single policy-construction call site
 * resolves this object with the same reference it resolves, and the single
 * dispatch call site carries that object unchanged to the port. Carrying
 * `secretRef` makes that pairing visible, though it cannot make a mismatched
 * plain-string value impossible at the type level.
 */
export interface SecretSinkPolicy {
  readonly secretRef: string;
  readonly allowedOrigins: readonly string[];
  readonly source: 'configured' | 'base-url-default';
}

/**
 * Normalizes an HTTP(S) URL to its canonical origin.
 *
 * @remarks
 * The `URL` constructor, rather than a regular expression, normalizes
 * unparsable input and parseable non-HTTP(S) schemes to `undefined`. Every
 * comparison in this module goes through this primitive, absorbing host-case
 * and default-port differences between authored configuration and a live
 * browser URL.
 *
 * @param url - The configuration or live-page URL to normalize.
 * @returns Its canonical HTTP(S) origin, or `undefined` when no valid origin exists.
 */
export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the allowed secret-sink origins for one target and secret reference.
 *
 * @remarks
 * An absent mapping for the requested reference uses the target's
 * `baseUrl` origin, while a present mapping, including an empty array,
 * replaces that default. Every candidate passes through {@link originOf}; if
 * any candidate cannot normalize, the policy denies everywhere
 * instead of silently dropping one entry from a partially broader list. This
 * defense-in-depth path is realistically reachable only through a gap in the
 * already shape-validated origin grammar or a corrupt `baseUrl`.
 *
 * @param target - The target providing the live configuration and defaults.
 * @param secretRef - The secret whose independently configured policy is needed.
 * @returns The normalized policy that travels unchanged to the browser port.
 */
export function resolveSecretSinkPolicy(
  target: TargetDefinition,
  secretRef: string,
): SecretSinkPolicy {
  const configuredOrigins = target.secretSinkOrigins?.[secretRef];
  const source = configuredOrigins === undefined ? 'base-url-default' : 'configured';
  const candidates = configuredOrigins ?? [target.baseUrl];
  const allowedOrigins: string[] = [];

  for (const candidate of candidates) {
    const origin = originOf(candidate);
    if (origin === undefined) {
      return { secretRef, allowedOrigins: [], source };
    }

    if (!allowedOrigins.includes(origin)) {
      allowedOrigins.push(origin);
    }
  }

  return {
    secretRef,
    allowedOrigins,
    source,
  };
}

/**
 * Determines whether a live page URL is allowed by a resolved policy.
 *
 * @remarks
 * The comparison first requires {@link originOf} to produce a defined current
 * origin, then checks that canonical value against
 * `policy.allowedOrigins`. It never performs a bare
 * `allowedOrigins.includes(originOf(currentUrl))`, so an undefined current
 * origin cannot match an impossible-but-defensively-guarded undefined list
 * entry.
 *
 * @param policy - The normalized policy constructed for the secret being filled.
 * @param currentUrl - The browser's current page URL.
 * @returns Whether the page is an HTTP(S) origin explicitly permitted by the policy.
 */
export function isAllowedSecretSinkOrigin(
  policy: SecretSinkPolicy,
  currentUrl: string,
): boolean {
  const currentOrigin = originOf(currentUrl);
  return currentOrigin !== undefined && policy.allowedOrigins.includes(currentOrigin);
}
