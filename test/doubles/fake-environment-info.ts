import type { EnvironmentInfo } from '../../src/ports/system.js';

/**
 * Creates a fixed environment fact without reading process-global variables.
 *
 * @param isCI - Whether the arranged scenario follows CI policy.
 * @returns An environment provider isolated from other scenarios.
 */
export function createFakeEnvironmentInfo(isCI: boolean): EnvironmentInfo {
  return {
    isCI(): boolean {
      return isCI;
    },
  };
}
