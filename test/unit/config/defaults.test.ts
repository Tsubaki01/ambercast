import { describe, expect, it } from 'vitest';
import { DEFAULT_RAW_CONFIG } from '#config/defaults.js';

describe('DEFAULT_RAW_CONFIG', () => {
  it('provides the complete pre-path-resolution configuration literal', () => {
    expect(DEFAULT_RAW_CONFIG).toStrictEqual({
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
    });
  });
});
