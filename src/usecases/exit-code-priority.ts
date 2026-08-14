import type { ExitCode } from '#core/errors/types.js';

/*
 * Defines the shared process-status policy for completed command batches.
 *
 * Both report builders delegate their batch aggregation here so the same
 * collection of outcomes resolves identically for replay and generation.
 * Callers contribute the exit codes already assigned to their conditions: a
 * second condition-token vocabulary would duplicate the classification
 * mapping owned by `ERROR_EXIT_CODES` without improving that boundary.
 */

/**
 * Ranks every {@link ExitCode} by aggregation priority: a lower rank wins
 * when a batch reports more than one non-success outcome.
 *
 * @remarks
 * `satisfies Record<ExitCode, number>` guarantees every exit code has a rank
 * entry, so a future {@link ExitCode} member cannot be added to the type
 * without also being assigned a place here — but that check alone cannot see
 * whether the assigned numbers are themselves valid. Nothing in the type
 * system stops two exit codes from sharing a rank, or a rank from being
 * skipped; {@link assertContiguousRankSequence} closes that gap at module
 * load. The exhaustiveness contract this table exists for only holds because
 * both checks pass together.
 */
const EXIT_CODE_RANK = {
  2: 0,
  3: 1,
  4: 2,
  1: 3,
  5: 4,
  0: 5,
} as const satisfies Record<ExitCode, number>;

/**
 * Verifies that a rank table assigns its entries a unique, contiguous
 * zero-based sequence, with no shared ranks and no gaps.
 *
 * @param rank - The rank table to verify.
 * @throws {Error} If two entries share a rank, or the ranks are not exactly
 *   `0..(entryCount - 1)`.
 * @example
 * ```ts
 * assertContiguousRankSequence({ high: 0, low: 1 }); // passes
 * assertContiguousRankSequence({ high: 0, low: 0 }); // throws: duplicate rank
 * ```
 * @remarks
 * A `satisfies Record<K, number>` clause can only prove a rank table's keys
 * cover every member of `K`; it cannot express that the table's *values* are
 * themselves complete and non-colliding — a duplicate or skipped rank number
 * compiles cleanly but silently breaks whatever ordering the table encodes.
 * This function is that missing runtime check. It takes any string-keyed
 * numeric record, rather than a table pinned to a specific key type, so it
 * can validate the value property alone, independent of which keys are
 * present.
 */
export function assertContiguousRankSequence(rank: Readonly<Record<string, number>>): void {
  const sortedRanks = Object.values(rank).sort((first, second) => first - second);
  const isContiguous = sortedRanks.every((value, index) => value === index);

  if (!isContiguous) {
    throw new Error(
      `Exit-code ranks must be a contiguous sequence starting at 0; received sorted ranks: ${JSON.stringify(sortedRanks)}.`,
    );
  }
}

assertContiguousRankSequence(EXIT_CODE_RANK);

/**
 * Selects the process exit code for a batch of applicable conditions.
 *
 * @param candidates - Exit codes contributed by individual results and
 *   command-level batch conditions.
 * @returns The highest-priority supplied exit code, or `0` when the batch has
 *   no non-success candidate.
 * @remarks
 * The selection contract is independent of iteration order and tolerates
 * duplicate candidates: it keeps the candidate with the lowest internal
 * priority rank. The authoritative order keeps precedence policy out of
 * individual report builders.
 *
 * Success is the result for an empty or all-success input. Its last-place
 * rank does not create a match when no candidate is present, so the
 * empty-input fallback remains explicit rather than implied by the table.
 */
export function selectExitCode(candidates: Iterable<ExitCode>): ExitCode {
  let best: ExitCode | undefined;

  for (const candidate of candidates) {
    if (best === undefined || EXIT_CODE_RANK[candidate] < EXIT_CODE_RANK[best]) {
      best = candidate;
    }
  }

  return best ?? 0;
}
