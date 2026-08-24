/**
 * Converts read-only freshness outcomes into the serializable check command
 * report returned from runtime to the CLI boundary.
 *
 * Report construction remains in the usecases layer so the command's stable
 * envelope and exit policy do not depend on filesystem composition or output
 * rendering. It accepts either a completed outcome or one classified
 * command-level failure, never both.
 */

import type { AmbercastError, ExitCode } from '#core/errors/types.js';
import { reportError } from '#report/error-mapping.js';
import { REPORT_SCHEMA_VERSION, type ReportEnvelope } from '#report/schema.js';
import { summarizeReport } from '#report/summarize.js';
import { InterruptedError } from '#core/errors/interrupted-error.js';
import { selectExitCode } from './exit-code-priority.js';
import type { CheckOptions, CheckOutcome } from './check.js';

/**
 * Timing and zero-match policy that determine stable command-level report
 * fields.
 */
interface CheckReportContext {
  /** Command start time already captured by runtime composition. */
  readonly startedAt: string;

  /** Elapsed command duration already measured by runtime composition. */
  readonly durationMs: number;

  /** Check options whose empty-selection policy affects the exit result. */
  readonly options: Pick<CheckOptions, 'allowEmpty' | 'list'>;
}

/**
 * The mutually exclusive input accepted by check report construction.
 *
 * A completed inspection carries every finding and case error, whereas a
 * thrown classified error becomes one run-scoped error. The union prevents a
 * caller from constructing a report that ambiguously claims both states.
 */
export type CheckReportInput = CheckReportContext & (
  | {
      /** Completed inspection outcome to translate into a check report. */
      readonly outcome: CheckOutcome;
      readonly error?: never;
    }
  | {
      /** Classified command-level failure to translate into a report error. */
      readonly outcome?: never;
      readonly error: AmbercastError;
    }
);

/**
 * Rendering-neutral check command result supplied to the CLI layer.
 */
export interface CheckReportOutput {
  /** Process status selected from the inspection outcome or classified error. */
  readonly exitCode: ExitCode;

  /** Complete machine-readable check report for JSON or human rendering. */
  readonly envelope: ReportEnvelope;
}

/**
 * Builds the report and exit status for one completed or failed check command.
 *
 * @param input - Outcome or error together with timing and zero-match policy.
 * @returns A complete check report paired with its process exit code.
 * @remarks
 * The builder uses the shared report-version constant and identity-set
 * summarizer after results and errors are assembled. Fresh and
 * fresh-without-grounding rows classify as passed; stale, missing, invalid,
 * and orphaned states classify as failed; listed and interruption-skipped rows
 * classify as skipped. A case-error-only identity contributes to both `total`
 * and `errored`, and a result with a matching case error is promoted without
 * being counted twice. Results need no per-item transform because inspection
 * and report contracts deliberately share their result shape.
 *
 * Exit candidates preserve the shared priority table: integrity findings,
 * disallowed zero-match inspections, and isolated I/O failures can coexist
 * without giving this report a command-specific precedence rule. A classified
 * command-level failure instead follows the common run-scoped error boundary
 * and retains an all-zero summary. An interrupted completed outcome appends
 * exactly one run-scoped `INTERRUPTED` environment error and contributes exit
 * 3. That error has no `caseId`, so interruption alone never increases
 * `total` or `errored`. Exit 4 is driven by the presence of failed finding
 * rows, independently of summary promotion: the same public identity may
 * summarize as skipped or errored while its retained integrity finding still
 * contributes exit 4.
 */
export function buildCheckReport(input: CheckReportInput): CheckReportOutput {
  if ('error' in input && input.error !== undefined) {
    const errors = [reportError(input.error, { scope: 'run' })];
    return {
      exitCode: input.error.exitCode,
      envelope: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: 'check',
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        summary: summarizeReport({ command: 'check', results: [], errors }),
        errors,
        results: [],
      },
    };
  }

  const outcome = input.outcome!;
  const results = [...outcome.results];
  const errors = outcome.errors.map(({ file, error }) => reportError(error, { scope: 'case', caseId: file }));
  const interrupted = outcome.interrupted;
  if (interrupted) errors.push(reportError(new InterruptedError(), { scope: 'run' }));
  const candidates: ExitCode[] = outcome.errors.map(({ error }) => error.exitCode);

  if (results.some(({ status }) => status !== 'fresh' && status !== 'fresh-without-grounding' && status !== 'listed' && status !== 'skipped')) {
    candidates.push(4);
  }
  if (outcome.noTestsFound && !input.options.allowEmpty && !input.options.list) {
    candidates.push(5);
  }
  if (interrupted) candidates.push(3);

  return {
    exitCode: selectExitCode(candidates),
    envelope: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'check',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      summary: summarizeReport({ command: 'check', results, errors }),
      errors,
      results,
    },
  };
}
