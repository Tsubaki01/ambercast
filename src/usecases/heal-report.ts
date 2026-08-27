import type { AmbercastError, ExitCode } from '#core/errors/types.js';
import { InterruptedError } from '#core/errors/interrupted-error.js';
import { reportError } from '#report/error-mapping.js';
import {
  REPORT_SCHEMA_VERSION,
  HealResult,
  type HealApplication,
  type HealStopReason,
  type ReportEnvelope,
} from '#report/schema.js';
import { summarizeReport } from '#report/summarize.js';
import { selectExitCode } from './exit-code-priority.js';
import type { HealCaseOutcome, HealOptions, HealOutcome } from './heal.js';

/**
 * A measured heal case after runtime confirmation and persistence settlement.
 *
 * `application` and `stopReason` are mandatory here because report construction
 * must never receive an unreconciled measurement with an undecided persistence
 * outcome.
 */
export interface SettledHealCaseOutcome extends HealCaseOutcome {
  readonly application: HealApplication;
  readonly stopReason: HealStopReason;
}

/**
 * A heal batch whose measured cases have all been settled for report output.
 *
 * Keeping this distinct from `HealOutcome` prevents confirmation knowledge
 * from leaking into `heal()` while making incomplete report input a type error.
 */
export interface SettledHealOutcome extends Omit<HealOutcome, 'results'> {
  readonly results: readonly SettledHealCaseOutcome[];
}

/**
 * Timing and zero-match policy that determine stable command-level report fields.
 */
interface HealReportContext {
  /** Command start time already captured by runtime composition. */
  readonly startedAt: string;

  /** Elapsed command duration already measured by runtime composition. */
  readonly durationMs: number;

  /** Empty-selection and list policy retained at the report boundary. */
  readonly options: Pick<HealOptions, 'allowEmpty' | 'list'>;
}

/**
 * The mutually exclusive input accepted by heal report construction.
 *
 * A completed batch carries its execution-backed outcomes and case errors;
 * `listed` and `skipped` identities become their respective identity-only
 * heal result rows, while each case error becomes a case-scoped envelope
 * error. A classified command-level failure instead becomes one run-scoped
 * error. The union prevents a report from claiming both states at once.
 */
export type HealReportInput = HealReportContext & (
  | { readonly outcome: SettledHealOutcome; readonly error?: never }
  | { readonly outcome?: never; readonly error: AmbercastError }
);

/**
 * Rendering-neutral heal command result supplied to the CLI layer.
 *
 * `envelope` is already report-safe: command composition must normalize its
 * elapsed duration to a finite, non-negative integer millisecond value at the
 * report boundary before calling this builder.
 */
export interface HealReportOutput {
  /** Process status selected from the completed batch or classified error. */
  readonly exitCode: ExitCode;

  /** Complete machine-readable heal report for JSON or human rendering. */
  readonly envelope: Extract<ReportEnvelope, { command: 'heal' }>;
}

/**
 * Builds the report and exit status for one completed or failed heal command.
 *
 * @param input - Outcome or error together with timing and zero-match policy.
 * @returns A complete heal report paired with its process exit code.
 * @remarks
 * This pure boundary translates only reportable facts. Completed case outcomes
 * become execution-backed heal rows; `listed` and `skipped` discovery
 * identities become identity-only rows; and case errors become case-scoped
 * envelope errors so the shared summarizer can account for a result/error
 * identity once. An interrupted batch appends exactly one run-scoped
 * `INTERRUPTED` error, making the stop observable without creating a case
 * identity.
 *
 * Exit candidates are collected rather than encoded in a heal-specific
 * precedence branch: each case error contributes its own exit code,
 * `partially-healed` and `unresolved` repair outcomes remain failure
 * candidates regardless of application, while declined application adds an
 * independent failure candidate. This preserves incomplete-repair failures
 * instead of replacing them with a persistence-only rule. `stage3Error` plus
 * `finalReplayError` contribute their
 * classified candidates. The shared selector then resolves their established
 * priority, as run reporting does for a result's attached error. The usual
 * disallowed empty selection and interruption candidates are added alongside
 * them. Progress indices, buffered overlays, and commit capabilities remain
 * internal so a report cannot imply that an unconfirmed candidate was
 * persisted. Command composition normalizes elapsed duration with
 * `Math.max(0, Math.round(...))` before this boundary, matching other command
 * reports. It passes the command-normalized integer duration through unchanged.
 */
export function buildHealReport(input: HealReportInput): HealReportOutput {
  if ('error' in input && input.error !== undefined) {
    const errors = [reportError(input.error, { scope: 'run' })];
    return { exitCode: input.error.exitCode, envelope: {
      schemaVersion: REPORT_SCHEMA_VERSION, command: 'heal', startedAt: input.startedAt,
      durationMs: input.durationMs, summary: summarizeReport({ command: 'heal', results: [], errors }), errors, results: [],
    } };
  }
  const outcome = input.outcome!;
  const results: HealResult[] = [
    ...outcome.results.map(({ baselineFirstFailureIndex: _baseline, finalFirstFailureIndex: _final, stage3Error: _stage3, finalReplayError: _replay, ...result }): HealResult => ({ ...result, status: 'completed', steps: [...result.steps] }) as HealResult),
    ...outcome.listed.map(({ file }): HealResult => ({ id: file, file, status: 'listed' })),
    ...outcome.skipped.map(({ file }): HealResult => ({ id: file, file, status: 'skipped' })),
  ];
  const errors = outcome.errors.map(({ file, error }) => reportError(error, { scope: 'case', caseId: file }));
  if (outcome.interrupted) errors.push(reportError(new InterruptedError(), { scope: 'run' }));
  const candidates: ExitCode[] = [
    ...outcome.errors.map(({ error }) => error.exitCode),
    ...outcome.results.flatMap(({ repairOutcome, application, stage3Error, finalReplayError }) => [
      ...(repairOutcome === 'partially-healed' || repairOutcome === 'unresolved' || application === 'declined' ? [1 as ExitCode] : []),
      ...(stage3Error === undefined ? [] : [stage3Error.exitCode]),
      ...(finalReplayError === undefined ? [] : [finalReplayError.exitCode]),
    ]),
    ...(outcome.noTestsFound && !input.options.allowEmpty && !input.options.list ? [5 as ExitCode] : []),
    ...(outcome.interrupted ? [3 as ExitCode] : []),
  ];
  return { exitCode: selectExitCode(candidates), envelope: {
    schemaVersion: REPORT_SCHEMA_VERSION, command: 'heal', startedAt: input.startedAt,
    durationMs: input.durationMs, summary: summarizeReport({ command: 'heal', results, errors }), errors, results,
  } };
}
