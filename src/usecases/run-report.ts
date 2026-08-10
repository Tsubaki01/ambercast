import type { AmbercastError, ExitCode } from '#core/errors/types.js';
import { reportError } from '#report/error-mapping.js';
import type { ReportEnvelope } from '#report/schema.js';
import { selectExitCode } from './exit-code-priority.js';
import type { RunOutcome } from './run.js';

/**
 * Command timing already measured outside report construction.
 *
 * Keeping timing as data makes report construction pure and leaves runtime to
 * choose the clock and command boundary.
 */
interface RunReportContext {
  /** UTC command start time in the structured-report format. */
  readonly startedAt: string;

  /** Elapsed command duration measured before report construction. */
  readonly durationMs: number;
}

/**
 * The mutually exclusive source for one run report.
 *
 * A completed outcome preserves per-case execution evidence. A classified
 * error thrown before any case can run, such as configuration loading failure,
 * instead becomes a command-scoped report error with its own exit code.
 */
export type RunReportInput = RunReportContext & (
  | {
      /** Completed replay outcomes to serialize. */
      readonly outcome: RunOutcome;
      readonly error?: never;
    }
  | {
      /** Classified command-level failure that precluded a batch outcome. */
      readonly outcome?: never;
      readonly error: AmbercastError;
    }
);

/**
 * Rendering-neutral run report and its selected process status.
 *
 * Runtime passes this complete value to the CLI, keeping serialization policy
 * independent of human or JSON rendering.
 */
export interface RunReportOutput {
  /** Highest-priority exit status present in the command outcome. */
  readonly exitCode: ExitCode;

  /** Complete machine-readable envelope for the `run` command. */
  readonly envelope: ReportEnvelope;
}

/**
 * Builds the report and exit status for one completed or failed replay command.
 *
 * @param input - A batch outcome or top-level classified error with timing.
 * @returns A complete run envelope paired with its process exit code.
 * @remarks
 * A top-level thrown `AmbercastError` short-circuits immediately with that
 * error's own exit code, just as `buildGenerateReport()` does; it represents a
 * command failure before a case outcome exists. For a completed batch, this
 * builder gives every applicable condition to `selectExitCode()` rather
 * than maintain a report-specific precedence branch. The shared order is 2,
 * then 3, 4, 1, 5, and 0, so a higher-priority outcome wins regardless of
 * where its case appears in the batch.
 *
 * Classified case errors contribute their established exit codes. An aborted
 * result without its own classified error contributes the generic exit-3
 * stopgap, and a failed assertion contributes exit 1; the no-tests-found
 * condition contributes exit 5. The abort rule is deliberately scoped to
 * each result rather than the whole batch. A classified exit-4 error can also
 * have an error status, and treating every error status as a batch-wide exit-3
 * condition would manufacture a higher-priority code that misreports that
 * classified failure. The stopgap exists because grounding misses,
 * unsupported run references, and unclassified browser-session errors have no
 * suitable reserved `ErrorKind`, yet a batch containing only those aborts must
 * not appear successful.
 *
 * Summary accounting counts every result by its run status: `total` covers all
 * cases; `passed`, `failed`, `errored`, and `skipped` each describe their
 * corresponding outcome. In contrast to generation reporting, `errored` is
 * meaningful here because replay has an explicit case error status.
 */
export function buildRunReport(input: RunReportInput): RunReportOutput {
  if ('error' in input && input.error !== undefined) {
    return {
      exitCode: input.error.exitCode,
      envelope: {
        schemaVersion: '1.0',
        command: 'run',
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
        errors: [reportError(input.error, { scope: 'run' })],
        results: [],
      },
    };
  }

  const outcome = input.outcome!;
  const errors = outcome.results.flatMap(({ result, error }) => (
    error === undefined ? [] : [reportError(error, { scope: 'case', caseId: result.id })]
  ));
  const candidates: ExitCode[] = outcome.results.flatMap<ExitCode>(({ result, error }) => {
    const resultCandidates: ExitCode[] = [];

    if (error !== undefined) {
      resultCandidates.push(error.exitCode);
    }
    if (result.status === 'error' && error === undefined) {
      resultCandidates.push(3);
    }
    if (result.status === 'failed') {
      resultCandidates.push(1);
    }

    return resultCandidates;
  });
  if (outcome.noTestsFound) {
    candidates.push(5);
  }
  const summary = { total: outcome.results.length, passed: 0, failed: 0, errored: 0, skipped: 0 };

  for (const { result } of outcome.results) {
    switch (result.status) {
      case 'passed':
        summary.passed += 1;
        break;
      case 'failed':
        summary.failed += 1;
        break;
      case 'error':
        summary.errored += 1;
        break;
      case 'skipped':
        summary.skipped += 1;
        break;
    }
  }

  const exitCode = selectExitCode(candidates);

  return {
    exitCode,
    envelope: {
      schemaVersion: '1.0',
      command: 'run',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      summary,
      errors,
      results: outcome.results.map(({ result }) => result),
    },
  };
}
