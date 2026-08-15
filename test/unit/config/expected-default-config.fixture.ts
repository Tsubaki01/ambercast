import type { ResolvedConfig } from '#core/config/schema.js';

export const EXPECTED_DEFAULT_CONFIG = {
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
    timeoutMs: 120_000,
  },
  viewer: {
    port: 4_600,
  },
  ci: {
    heal: false,
    updateGroundingCache: false,
  },
} as const satisfies Omit<ResolvedConfig, 'projectRoot'>;
