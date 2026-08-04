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
 *
 * @returns A snapshot that will omit absent or empty environment values.
 *
 * @remarks
 * This is deliberately a plain real-adapter function rather than a port:
 * issue #6 owns the later composition step, while this capture has no
 * independently substitutable runtime consumer or behavioral contract of its
 * own. A fake or contract would add a boundary before a consumer needs it.
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
