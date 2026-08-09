import type { AmbercastError, ExitCode } from '#core/errors/types.js';
import { reportError } from '#report/error-mapping.js';
import type { ReportEnvelope } from '#report/schema.js';
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
 * command failure before a case outcome exists. Otherwise this function scans
 * the whole batch, rather than using `generate-report.ts`'s first failed file,
 * because file order must not let one case hide a higher-priority error in
 * another.
 *
 * The first matching row in this priority scan determines the exit code:
 *
 * | Condition anywhere in the completed batch | Exit |
 * | --- | --- |
 * | A case error has kind `config-invalid`, `secret-unresolved`, `target-unresolved`, or `secret-literal-rejected` | 2 |
 * | A case error has kind `missing-plan`, `stale-ir`, or `integrity-violation` | 4 |
 * | A case error has kind `browser-launch-failed`, `ai-executor-unavailable`, `ai-response-invalid`, `fs-io-error`, or `unexpected-crash`, or any `RunResult.status` is `'error'` | 3 |
 * | Any `RunResult.status` is `'failed'` | 1 |
 * | No tests were found | 5 |
 * | None of the preceding conditions | 0 |
 *
 * Thus the scan deliberately checks exit 2, then exit 4, then exit 3, followed
 * by exits 1, 5, and 0: a usage failure in any case outranks an environment
 * failure in any other case, regardless of discovery order. The explicit
 * `RunResult.status === 'error'` branch is essential. The unified case-abort
 * stopgap for grounding misses, unsupported run references, and unclassified
 * browser-session errors intentionally creates no `errors[]` entry because no
 * reserved `ErrorKind` fits it. Treating that status as an exit-3 condition
 * prevents a batch containing only such aborts from falling through to exit 0.
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
  const errorKinds = new Set(outcome.results.flatMap(({ error }) => (
    error === undefined ? [] : [error.kind]
  )));
  const statuses = new Set(outcome.results.map(({ result }) => result.status));
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

  const exitCode: ExitCode = errorKinds.has('config-invalid')
    || errorKinds.has('secret-unresolved')
    || errorKinds.has('target-unresolved')
    || errorKinds.has('secret-literal-rejected')
    ? 2
    : errorKinds.has('missing-plan')
      || errorKinds.has('stale-ir')
      || errorKinds.has('integrity-violation')
      ? 4
      : errorKinds.has('browser-launch-failed')
        || errorKinds.has('ai-executor-unavailable')
        || errorKinds.has('ai-response-invalid')
        || errorKinds.has('fs-io-error')
        || errorKinds.has('unexpected-crash')
        || statuses.has('error')
        ? 3
        : statuses.has('failed')
          ? 1
          : outcome.noTestsFound
            ? 5
            : 0;

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
