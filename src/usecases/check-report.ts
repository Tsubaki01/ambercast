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
import type { ReportEnvelope } from '#report/schema.js';
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
 * `errored` remains zero because check I/O failures are case-scoped errors,
 * not freshness statuses. Results need no per-item transform because the
 * inspection and report contracts deliberately share their result shape.
 *
 * Exit candidates preserve the shared priority table: integrity findings,
 * disallowed zero-match inspections, and isolated I/O failures can coexist
 * without giving this report a command-specific precedence rule. A classified
 * command-level failure instead follows the common run-scoped error boundary.
 */
export function buildCheckReport(input: CheckReportInput): CheckReportOutput {
  if ('error' in input && input.error !== undefined) {
    return {
      exitCode: input.error.exitCode,
      envelope: {
        schemaVersion: '1.0',
        command: 'check',
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
        errors: [reportError(input.error, { scope: 'run' })],
        results: [],
      },
    };
  }

  const outcome = input.outcome!;
  const results = [...outcome.results];
  const errors = outcome.errors.map(({ file, error }) => reportError(error, { scope: 'case', caseId: file }));
  const passed = results.filter(({ status }) => status === 'fresh').length;
  const failed = results.length - passed;
  const candidates: ExitCode[] = outcome.errors.map(({ error }) => error.exitCode);

  if (failed > 0) {
    candidates.push(4);
  }
  if (outcome.noTestsFound && !input.options.allowEmpty && !input.options.list) {
    candidates.push(5);
  }

  return {
    exitCode: selectExitCode(candidates),
    envelope: {
      schemaVersion: '1.0',
      command: 'check',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      summary: { total: results.length, passed, failed, errored: 0, skipped: 0 },
      errors,
      results,
    },
  };
}
