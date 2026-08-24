import type { AmbercastError, ExitCode } from '#core/errors/types.js';
import { reportError } from '#report/error-mapping.js';
import { REPORT_SCHEMA_VERSION, type ReportEnvelope, type RunResult } from '#report/schema.js';
import { summarizeReport } from '#report/summarize.js';
import { InterruptedError } from '#core/errors/interrupted-error.js';
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

  /**
   * Complete machine-readable envelope for the `run` command.
   *
   * @remarks
   * This builder only produces the `run` branch, so its output preserves that
   * narrower command contract for runtime consumers.
   */
  readonly envelope: Extract<ReportEnvelope, { command: 'run' }>;
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
 * Every envelope built here marks report persistence as `'not-attempted'`.
 * This builder has no visibility into storage, so runtime alone replaces that
 * provisional state after an attempted write. The separation keeps every
 * payload persisted by the command from retaining `'not-attempted'`.
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
 * The builder uses the shared report-version constant and identity-set
 * summarizer. Passed execution rows classify as passed, failed assertions as
 * failed, execution errors and matching case errors as errored, and listed or
 * interruption-skipped identities as skipped. Duplicate identities and a
 * result/error pair contribute once to `total`; run-scoped errors never enter
 * case accounting. Listed and skipped rows enter the envelope separately from
 * case outcomes, preserving the evidence requirements of execution-backed
 * results.
 *
 * An interrupted outcome appends exactly one run-scoped `INTERRUPTED`
 * environment error and contributes exit 3 without a `caseId`. This batch fact
 * does not replace terminal case evidence or the existing unclassified
 * case-abort fallback, and the shared selector preserves every higher-priority
 * condition. A command-level error has no results and therefore retains an
 * all-zero shared summary.
 */
export function buildRunReport(input: RunReportInput): RunReportOutput {
  if ('error' in input && input.error !== undefined) {
    const errors = [reportError(input.error, { scope: 'run' })];
    return {
      exitCode: input.error.exitCode,
      envelope: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: 'run',
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        summary: summarizeReport({ command: 'run', results: [], errors }),
        errors,
        results: [],
        reportPersistence: 'not-attempted',
      },
    };
  }

  const outcome = input.outcome!;
  const results: RunResult[] = [
    ...outcome.results.map(({ result }) => result),
    ...outcome.listed.map(({ file }): RunResult => ({ id: file, file, status: 'listed' })),
    ...outcome.skipped
      .map(({ file }): RunResult => ({ id: file, file, status: 'skipped' })),
  ];
  const errors = outcome.results.flatMap(({ result, error }) => (
    error === undefined ? [] : [reportError(error, { scope: 'case', caseId: result.id })]
  ));
  const interrupted = outcome.interrupted;
  if (interrupted) errors.push(reportError(new InterruptedError(), { scope: 'run' }));
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
  if (interrupted) candidates.push(3);
  const summary = summarizeReport({ command: 'run', results, errors });

  const exitCode = selectExitCode(candidates);

  return {
    exitCode,
    envelope: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'run',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      summary,
      errors,
      results,
      reportPersistence: 'not-attempted',
    },
  };
}
