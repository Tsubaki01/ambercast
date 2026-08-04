import { describe, expect, it } from 'vitest';
import { DEFAULT_RAW_CONFIG } from '#config/defaults.js';
import { EXPECTED_DEFAULT_CONFIG } from './expected-default-config.fixture.js';

describe('DEFAULT_RAW_CONFIG', () => {
  it('provides the complete pre-path-resolution configuration literal', () => {
    expect(DEFAULT_RAW_CONFIG).toStrictEqual(EXPECTED_DEFAULT_CONFIG);
  });
});
