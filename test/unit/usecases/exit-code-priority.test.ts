import { describe, expect, it } from 'vitest';
import type { ExitCode } from '#core/errors/types.js';
import {
  assertContiguousRankSequence,
  selectExitCode,
} from '#usecases/exit-code-priority.js';

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

describe('assertContiguousRankSequence', () => {
  it('does not throw for a contiguous six-entry rank sequence', () => {
    expect(() =>
      assertContiguousRankSequence({ a: 0, b: 1, c: 2, d: 3, e: 4, f: 5 }),
    ).not.toThrow();
  });

  it('does not throw for a single-entry rank sequence', () => {
    expect(() => assertContiguousRankSequence({ a: 0 })).not.toThrow();
  });

  it('does not throw for an empty rank sequence', () => {
    expect(() => assertContiguousRankSequence({})).not.toThrow();
  });

  it('throws for duplicate ranks', () => {
    expect(() => assertContiguousRankSequence({ a: 0, b: 0 })).toThrow();
  });

  it('throws for a rank sequence with a gap', () => {
    expect(() => assertContiguousRankSequence({ a: 0, b: 2 })).toThrow();
  });

  it('throws for a rank sequence that does not start at 0', () => {
    expect(() => assertContiguousRankSequence({ a: -1, b: 1 })).toThrow();
  });
});
