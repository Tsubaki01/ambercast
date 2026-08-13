import type { AmbercastError, ExitCode } from '#core/errors/types.js';
import { reportError } from '#report/error-mapping.js';
import type { ReportEnvelope, RunResult } from '#report/schema.js';
import { selectExitCode } from './exit-code-priority.js';
import type { RunOptions, RunOutcome } from './run.js';

/**
 * Command timing and zero-match policy already measured or parsed outside report construction.
 *
 * Keeping both as data makes report construction pure and leaves runtime to
 * choose the clock, command boundary, and CLI policy.
 */
interface RunReportContext {
  /** UTC command start time in the structured-report format. */
  readonly startedAt: string;

  /** Elapsed command duration measured before report construction. */
  readonly durationMs: number;

  /**
   * Command policy that changes only zero-match exit selection.
   *
   * Replay carries `allowEmpty` for this report boundary, while list mode
   * additionally tells the zero-match policy that discovery was intentional.
   */
  readonly options: Pick<RunOptions, 'allowEmpty' | 'list'>;
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
      /** Completed replay and discovery outcomes to serialize. */
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
 * @param input - A batch outcome or top-level classified error with timing and
 * the required `allowEmpty`/`list` reporting policy.
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
 * stopgap, and a failed assertion contributes exit 1. The no-tests-found
 * condition contributes exit 5 only when neither `allowEmpty` nor list mode
 * makes the empty selection intentional. The abort rule is deliberately
 * scoped to each result rather than the whole batch. A classified exit-4
 * error can also have an error status, and treating every error status as a
 * batch-wide exit-3 condition would manufacture a higher-priority code that
 * misreports that classified failure. The stopgap exists because grounding
 * misses, unsupported run references, and unclassified browser-session
 * errors have no suitable reserved `ErrorKind`, yet a batch containing only
 * those aborts must not appear successful.
 *
 * Summary accounting counts every public result by its run status: `total`
 * covers executed cases and listed files; `passed` includes executed passes
 * and listed discovery results; while `failed`, `errored`, and `skipped`
 * remain execution-only. Listed files enter the envelope here rather than
 * through case outcomes, preserving the execution evidence required by the
 * runtime's report-safe path handling.
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
  const results: RunResult[] = [
    ...outcome.results.map(({ result }) => result),
    ...outcome.listed.map(({ file }): RunResult => ({ id: file, file, status: 'listed' })),
  ];
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
  if (outcome.noTestsFound && !input.options.allowEmpty && !input.options.list) {
    candidates.push(5);
  }
  const summary = { total: results.length, passed: 0, failed: 0, errored: 0, skipped: 0 };

  for (const result of results) {
    switch (result.status) {
      case 'passed':
      case 'listed':
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
      results,
    },
  };
}
