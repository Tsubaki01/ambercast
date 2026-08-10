import { describe, expect, it } from 'vitest';
import type { ExitCode } from '#core/errors/types.js';
import { selectExitCode } from '#usecases/exit-code-priority.js';

const PRIORITY_PAIRS: readonly (readonly [ExitCode, ExitCode])[] = [
  [2, 3],
  [2, 4],
  [2, 1],
  [2, 5],
  [2, 0],
  [3, 4],
  [3, 1],
  [3, 5],
  [3, 0],
  [4, 1],
  [4, 5],
  [4, 0],
  [1, 5],
  [1, 0],
  [5, 0],
];

describe('selectExitCode', () => {
  it.each([0, 1, 2, 3, 4, 5] as const)(
    'returns the solo candidate exit code %i',
    (exitCode) => {
      expect(selectExitCode([exitCode])).toBe(exitCode);
    },
  );

  it('returns exit code 0 for an empty candidate iterable', () => {
    expect(selectExitCode([])).toBe(0);
  });

  it.each(PRIORITY_PAIRS)(
    'selects exit %i over lower-priority exit %i regardless of candidate order',
    (higherPriority, lowerPriority) => {
      expect(selectExitCode([higherPriority, lowerPriority])).toBe(higherPriority);
      expect(selectExitCode([lowerPriority, higherPriority])).toBe(higherPriority);
    },
  );

  it('deduplicates repeated candidates without changing the selected exit code', () => {
    expect(selectExitCode([3, 3, 2])).toBe(2);
  });
});
