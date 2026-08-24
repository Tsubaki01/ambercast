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
import { REPORT_SCHEMA_VERSION, type GenerateResult, type ReportEnvelope } from '#report/schema.js';
import { summarizeReport } from '#report/summarize.js';
import { InterruptedError } from '#core/errors/interrupted-error.js';
import { selectExitCode } from './exit-code-priority.js';
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
    case 'skipped':
      return { ...identity, status: result.status };
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
 * This helper owns only serializable reporting policy. It uses the shared
 * report-version constant and delegates accounting to the identity-set
 * summarizer after results and case errors are assembled. `generated`,
 * `would-generate`, and `skipped-fresh` rows classify as passed; failed rows classify as
 * failed unless a matching case error promotes the same identity to errored;
 * listed and interruption-skipped rows classify as skipped. Duplicate rows and
 * result/error pairs never inflate `total`.
 *
 * Every failed file becomes one case-scoped `ReportError` whose `caseId` is
 * the file path. The error-kind correspondence selects its usage or
 * environment kind and stable report code. A top-level `AmbercastError`, such
 * as a configuration-load or provider-resolution failure before file work,
 * instead becomes one run-scoped error with an empty result list.
 *
 * A top-level thrown error retains its own exit code because no completed batch
 * exists and its empty result set yields an all-zero shared summary. For a
 * completed batch, this builder contributes every applicable
 * code to `selectExitCode()`: failures contribute their classified code or the
 * generic exit-3 fallback when malformed input supplies no classification, and
 * strict ambiguities contribute exit 1. The shared 2, 3, 4, 1, 5, 0 order then
 * selects the highest-priority condition across the batch, independent of
 * file order.
 *
 * When the completed outcome is interrupted, the builder appends exactly one
 * run-scoped `INTERRUPTED` environment error and contributes exit 3. The error
 * has no `caseId`, so it does not change case counts; a higher-priority exit 2
 * condition still wins through the common selector.
 *
 * A disallowed zero-match condition contributes exit 5 to that same list,
 * instead of returning early. The normal zero-match outcome has no results,
 * but representing it as a candidate also makes malformed yet type-valid
 * outcomes obey the one common priority policy when another condition is
 * present. `allowEmpty` and `list` still decide whether zero matches count as
 * a failure; they do not decide how it ranks. The zero-match envelope is
 * error-free with an all-zero summary.
 */
export function buildGenerateReport(input: GenerateReportInput): GenerateReportOutput {
  if ('error' in input && input.error !== undefined) {
    const errors = [reportError(input.error, { scope: 'run' })];
    return {
      exitCode: input.error.exitCode,
      envelope: {
        schemaVersion: REPORT_SCHEMA_VERSION,
        command: 'generate',
        startedAt: input.startedAt,
        durationMs: input.durationMs,
        summary: summarizeReport({ command: 'generate', results: [], errors }),
        errors,
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
  const interrupted = outcome.interrupted;
  if (interrupted) errors.push(reportError(new InterruptedError(), { scope: 'run' }));
  const failed = outcome.results.filter((result) => result.status === 'failed');
  const candidates: ExitCode[] = failed.map<ExitCode>((result) => result.error?.exitCode ?? 3);
  const hasStrictAmbiguities = input.options.strict && outcome.results.some((result) => (
    (result.status === 'generated' || result.status === 'would-generate')
    && (result.ambiguities?.length ?? 0) > 0
  ));

  if (hasStrictAmbiguities) {
    candidates.push(1);
  }
  if (outcome.noTestsFound && !input.options.allowEmpty && !input.options.list) {
    candidates.push(5);
  }
  if (interrupted) candidates.push(3);

  const exitCode = selectExitCode(candidates);

  return {
    exitCode,
    envelope: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      command: 'generate',
      startedAt: input.startedAt,
      durationMs: input.durationMs,
      summary: summarizeReport({ command: 'generate', results, errors }),
      errors,
      results,
    },
  };
}
