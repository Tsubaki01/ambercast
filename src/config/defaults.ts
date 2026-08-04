/*
 * Supplies the complete configuration used when a project has no
 * `ambercast.config.json`. The file is optional, so these defaults must be a
 * usable configuration in their own right, including a real target and its
 * default selection rather than an empty placeholder for a later layer to
 * repair.
 *
 * `testDir` and `runsDir` intentionally remain relative here even though the
 * eventual ResolvedConfig contract carries absolute paths. The distinction is
 * an invariant of the loader, not of TypeScript's string type: loadConfig
 * alone anchors these opaque path strings to the selected config file or its
 * caller's directory, just as StorageAdapter leaves path interpretation to
 * its caller.
 */

import type { ResolvedConfig } from '#core/config/schema.js';

/**
 * Provides the complete pre-path-resolution configuration for projects that
 * do not provide a configuration file.
 *
 * @remarks
 * The eventual loader will create fresh resolved values from this template,
 * so consumers cannot make one load influence another by mutating a default
 * array, target, or policy group. Its two path fields are purposefully
 * project-relative at this boundary and become absolute only during loading.
 */
export const DEFAULT_RAW_CONFIG = {
  testDir: 'tests/ambercast',
  runsDir: 'tests/ambercast/.runs',
  testMatch: ['**/*.test.md'],
  testIgnore: ['**/.runs/**', '**/*.ambercast.plan.json', '**/*.ambercast.grounding.json'],
  targets: {
    'web-user': {
      baseUrl: 'http://localhost:3000',
      browser: 'chromium',
    },
  },
  defaultTarget: 'web-user',
  ai: {
    provider: 'auto',
  },
  viewer: {
    port: 4_600,
  },
  ci: {
    heal: false,
    updateGroundingCache: false,
  },
} as const satisfies ResolvedConfig;
