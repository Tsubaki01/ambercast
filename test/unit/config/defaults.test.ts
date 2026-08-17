import { describe, expect, it } from 'vitest';
import { DEFAULT_RAW_CONFIG } from '#config/defaults.js';
import { GROUNDING_SUFFIX, PLAN_SUFFIX } from '#core/layout/resolve.js';
import { EXPECTED_DEFAULT_CONFIG } from './expected-default-config.fixture.js';

describe('DEFAULT_RAW_CONFIG', () => {
  it('provides the complete pre-path-resolution configuration literal', () => {
    expect(DEFAULT_RAW_CONFIG).toStrictEqual(EXPECTED_DEFAULT_CONFIG);
  });

  it('keeps companion ignore patterns aligned with the shared layout suffixes', () => {
    expect(DEFAULT_RAW_CONFIG.testIgnore).toStrictEqual([
      '**/.runs/**',
      `**/*${PLAN_SUFFIX}`,
      `**/*${GROUNDING_SUFFIX}`,
    ]);
  });
});
