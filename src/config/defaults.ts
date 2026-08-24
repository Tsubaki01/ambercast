/*
 * Supplies the complete configuration used when a project has no
 * `ambercast.config.json`. The file is optional, so these defaults must be a
 * usable configuration in their own right, including a real target and its
 * default selection rather than an empty placeholder for a later layer to
 * repair.
 *
 * `testDir` and `runsDir` intentionally remain relative here even though the
 * ResolvedConfig contract carries absolute paths. The distinction is
 * an invariant of the loader, not of TypeScript's string type: loadConfig
 * alone anchors these opaque path strings to the selected config file or its
 * caller's directory, just as StorageAdapter leaves path interpretation to
 * its caller. `projectRoot` has no static relative default because loading
 * derives it from the caller directory or selected configuration file, so this
 * template purposefully omits it rather than supply a value that cannot be
 * meaningful before loading.
 */

import type { ResolvedConfig } from '#core/config/schema.js';
import { GROUNDING_SUFFIX, PLAN_SUFFIX } from '#core/layout/resolve.js';

/**
 * Provides the complete pre-path-resolution configuration for projects that
 * do not provide a configuration file.
 *
 * @remarks
 * The loader creates fresh resolved values from this template,
 * so consumers cannot make one load influence another by mutating a default
 * array, target, or policy group. Its two path fields are purposefully
 * project-relative at this boundary and become absolute only during loading.
 */
export const DEFAULT_RAW_CONFIG = {
  testDir: 'tests/ambercast',
  runsDir: 'tests/ambercast/.runs',
  testMatch: ['**/*.test.md'],
  testIgnore: ['**/.runs/**', `**/*${PLAN_SUFFIX}`, `**/*${GROUNDING_SUFFIX}`],
  targets: {
    'web-user': {
      baseUrl: 'http://localhost:3000',
      browser: 'chromium',
    },
  },
  defaultTarget: 'web-user',
  ai: {
    provider: 'auto',
    timeoutMs: 120_000,
  },
  viewer: {
    port: 4_600,
  },
  ci: {
    heal: false,
    updateGroundingCache: false,
  },
  /*
   * Grounding defaults preserve this repository's committed-artifact
   * posture while ensuring run persists grounding automatically outside CI
   * under the auto default. A project can opt into an uncommitted cache or an
   * explicit per-invocation write request without changing either default for
   * every other project.
   */
  grounding: {
    repositoryPolicy: 'committed',
    localWriteBack: 'auto',
  },
} as const satisfies Omit<ResolvedConfig, 'projectRoot'>;
