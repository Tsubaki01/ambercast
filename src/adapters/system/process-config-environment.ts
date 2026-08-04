/*
 * Captures configuration-related process variables at the real system
 * boundary.
 *
 * The configuration loader receives this data as an injected snapshot rather
 * than reading `process.env`, so its selection and validation behavior remains
 * deterministic. Direct environment access is intentionally confined to this
 * ESLint-exempt adapter path.
 */

import type { ConfigEnvSnapshot } from '#core/config/schema.js';

/**
 * Captures the optional configuration selection variables from the process.
 * It maps `process.env.AMBERCAST_CONFIG` to the returned snapshot's
 * `configPathOverride` field and `process.env.AMBERCAST_AI_PROVIDER` to its
 * `aiProviderRaw` field.
 *
 * @returns A snapshot that will omit absent or empty environment values.
 *
 * @remarks
 * This is deliberately a plain real-adapter function rather than a port.
 * `loadConfig()` already accepts substitutable snapshot data as a plain
 * injected parameter, so wrapping this zero-argument producer in a callable
 * port would duplicate the injection seam that already exists at the
 * `loadConfig()` boundary.
 *
 * The eventual capture will preserve every nonempty value verbatim and treat
 * an empty string as absent, preventing an empty variable from becoming an
 * explicit empty override. `aiProviderRaw` will remain an unvalidated string:
 * `loadConfig()` owns provider vocabulary validation, so this boundary must
 * not duplicate configuration-domain policy.
 */
export function readConfigEnvironment(): ConfigEnvSnapshot {
  throw new Error('not implemented');
}
