import type { ExitCode } from '#core/errors/types.js';

/**
 * Defines the shared process-status policy for completed command batches.
 *
 * Both report builders delegate their batch aggregation here so the same
 * collection of outcomes resolves identically for replay and generation.
 * Callers contribute the exit codes already assigned to their conditions: a
 * second condition-token vocabulary would duplicate the classification
 * mapping owned by `ERROR_EXIT_CODES` without improving that boundary.
 */

const EXIT_CODE_PRIORITY: readonly ExitCode[] = [2, 3, 4, 1, 5, 0];

/**
 * Selects the process exit code for a batch of applicable conditions.
 *
 * @param candidates - Exit codes contributed by individual results and
 *   command-level batch conditions.
 * @returns The highest-priority supplied exit code, or `0` when the batch has
 *   no non-success candidate.
 * @remarks
 * The selection contract is independent of iteration order and tolerates
 * duplicate candidates: exit codes rank as 2, then 3, 4, 1, 5, and finally
 * 0. The authoritative order keeps precedence policy out of individual
 * report builders.
 *
 * Success is the result for an empty or all-success input. Its last position
 * in the priority table does not create a match when no candidate is present,
 * so the empty-input fallback remains explicit rather than implied by the
 * table.
 */
export function selectExitCode(candidates: Iterable<ExitCode>): ExitCode {
  const candidateSet = new Set<ExitCode>(candidates);

  return EXIT_CODE_PRIORITY.find((exitCode) => candidateSet.has(exitCode)) ?? 0;
}
