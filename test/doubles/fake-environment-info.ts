import type { EnvironmentInfo } from '../../src/ports/system.js';

export function createFakeEnvironmentInfo(_isCI: boolean): EnvironmentInfo {
  return {
    isCI(): boolean {
      throw new Error('not implemented');
    },
  };
}
