/**
 * Converts generation application outcomes into the serializable command
 * report that runtime returns to the CLI boundary.
 *
 * Keeping report-shape construction in the usecases layer lets runtime
 * compose configuration and concrete adapters while reusing report's stable
 * error mapping. The helper receives only the completed application outcome
 * or classified failure plus command policy and timing; it never loads
 * configuration, selects a provider, or performs I/O.
 */

import type { AmbercastError, ExitCode } from '#core/errors/types.js';
import { reportError } from '#report/error-mapping.js';
import type { GenerateResult, ReportEnvelope } from '#report/schema.js';
import type { GenerateOptions, GenerateOutcome } from './generate.js';

function reportResult(
  result: GenerateOutcome['results'][number],
  dryRun: boolean,
): GenerateResult {
  const identity = { id: result.file, file: result.file };

  switch (result.status) {
    case 'generated':
      return { ...identity, status: result.status, dryRun: false, planFile: result.planFile!, ambiguities: [...result.ambiguities!] };
    case 'would-generate':
      return { ...identity, status: result.status, dryRun: true, planFile: result.planFile!, ambiguities: [...result.ambiguities!] };
    case 'skipped-fresh':
      return { ...identity, status: result.status, dryRun, planFile: result.planFile! };
    case 'listed':
      return { ...identity, status: result.status, dryRun: false };
    case 'failed':
      return { ...identity, status: result.status, dryRun };
  }
}

/**
 * Timing and policy that determine the report's stable command-level fields.
 */
interface GenerateReportContext {
  /** Command start time already captured by runtime composition. */
  readonly startedAt: string;

  /** Elapsed command duration already measured by runtime composition. */
  readonly durationMs: number;

  /** Generation options whose strict, dry-run, and zero-match policy affect reporting. */
  readonly options: Pick<GenerateOptions, 'strict' | 'dryRun' | 'allowEmpty' | 'list'>;
}

/**
 * The mutually exclusive result supplied for report construction.
 *
 * A completed usecase outcome preserves every per-file result, while a thrown
 * classified error becomes a command-level report error. The union prevents a
 * caller from manufacturing an ambiguous report that claims both forms at
 * once.
 */
export type GenerateReportInput = GenerateReportContext & (
  | {
      /** Completed generation result to convert into per-file report results. */
      readonly outcome: GenerateOutcome;
      readonly error?: never;
    }
  | {
      /** Classified command-level failure to convert into a report error. */
      readonly outcome?: never;
      readonly error: AmbercastError;
    }
);

/**
 * The rendering-neutral result returned from generation report construction.
 */
export interface GenerateReportOutput {
  /** Process status selected from the application outcome or classified error. */
  readonly exitCode: ExitCode;

  /** Complete machine-readable generate report for CLI rendering. */
  readonly envelope: ReportEnvelope;
}

/**
 * Builds the report and exit status for one completed or failed generation command.
 *
 * @param input - Outcome or error together with timing and reporting policy.
 * @returns A complete generate report paired with its process exit code.
 * @remarks
 * This helper owns only serializable reporting policy. Its summary has one
 * result per resolved file: `total` is `results.length`; generated, fresh,
 * previewed, and listed results are `passed`; failed results are `failed`; and
 * `errored` and `skipped` remain zero because generate has neither outcome.
 *
 * Every failed file becomes one case-scoped `ReportError` whose `caseId` is
 * the file path. The existing error-kind correspondence selects its usage or
 * environment kind and stable report code. A top-level `AmbercastError`, such
 * as a configuration-load or provider-resolution failure before file work,
 * instead becomes one run-scoped error with an empty result list.
 *
 * Exit selection is deterministic when several conditions coexist: a thrown
 * top-level error wins with its own exit code; then a disallowed zero match
 * (`noTestsFound` without `allowEmpty` or `list`) selects 5; then the first
 * failed result in file order supplies its error's exit code (or the generic
 * exit 3 fallback if a malformed outcome omitted that error); then strict mode
 * selects 1 when any generated or previewed result has ambiguities; otherwise
 * the command succeeds with 0. The zero-match envelope is error-free with an
 * all-zero summary. Runtime composes and invokes this helper; the CLI only
 * renders the resulting envelope and exits.
 */
export function buildGenerateReport(input: GenerateReportInput): GenerateReportOutput {
  if ('error' in input && input.error !== undefined) {
    return {
      exitCode: input.error.exitCode,
      envelope: {
        schemaVersion: '1.0',
        command: 'generate',
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        summary: { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 },
        errors: [reportError(input.error, { scope: 'run' })],
        results: [],
      },
    };
  }

  const outcome = input.outcome!;
  const results = outcome.results.map((result) => reportResult(result, input.options.dryRun));
  const errors = outcome.results.flatMap((result) => (
    result.status === 'failed' && result.error !== undefined
      ? [reportError(result.error, { scope: 'case', caseId: result.file })]
      : []
  ));
  const failed = outcome.results.filter((result) => result.status === 'failed');
  const passed = outcome.results.length - failed.length;

  const exitCode: ExitCode = outcome.noTestsFound && !input.options.allowEmpty && !input.options.list
    ? 5
    : failed.length > 0
      ? failed[0]?.error?.exitCode ?? 3
      : input.options.strict && outcome.results.some((result) => (
        (result.status === 'generated' || result.status === 'would-generate')
        && (result.ambiguities?.length ?? 0) > 0
      )) ? 1 : 0;

  return {
    exitCode,
    envelope: {
      schemaVersion: '1.0',
      command: 'generate',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      summary: { total: outcome.results.length, passed, failed: failed.length, errored: 0, skipped: 0 },
      errors,
      results,
    },
  };
}
