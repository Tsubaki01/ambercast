import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.js';

describe('default Vitest configuration', () => {
  it('keeps opt-in contract lanes out of the default suite', () => {
    expect(config.test).toBeDefined();
    expect(config.test?.exclude).toEqual(expect.arrayContaining([
      'test/contract-ai/**',
      'test/contract-browser/**',
    ]));
  });
});
