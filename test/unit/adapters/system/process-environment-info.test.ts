import { describe, expect, it } from 'vitest';
import { createProcessEnvironmentInfo } from '../../../../src/adapters/system/process-environment-info.js';
import { registerEnvironmentInfoContract } from '../../../contracts/environment-info.contract.js';

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

let contractCi: string | undefined;

registerEnvironmentInfoContract({
  createEnvironment(isCI) {
    contractCi = process.env.CI;
    process.env.CI = isCI ? 'true' : 'false';

    return createProcessEnvironmentInfo();
  },
  dispose() {
    restoreEnvironmentVariable('CI', contractCi);
    contractCi = undefined;
  },
});

describe('createProcessEnvironmentInfo()', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['FALSE', true],
    ['0', true],
    ['true', true],
    ['   ', true],
  ])('treats CI=%j as %s', (ci, expected) => {
    const previousCi = process.env.CI;

    try {
      restoreEnvironmentVariable('CI', ci);

      expect(createProcessEnvironmentInfo().isCI()).toBe(expected);
    } finally {
      restoreEnvironmentVariable('CI', previousCi);
    }
  });

  it('reads CI from the live process environment after construction', () => {
    const previousCi = process.env.CI;

    try {
      delete process.env.CI;
      const environment = createProcessEnvironmentInfo();
      process.env.CI = 'true';

      expect(environment.isCI()).toBe(true);
    } finally {
      restoreEnvironmentVariable('CI', previousCi);
    }
  });
});
