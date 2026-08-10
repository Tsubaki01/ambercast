import { describe, expect, it } from 'vitest';
import { readCommandEnvironment } from '../../../../src/adapters/system/process-command-environment.js';

describe('readCommandEnvironment()', () => {
  it('returns the live process environment object', () => {
    expect(readCommandEnvironment()).toBe(process.env);
  });
});
