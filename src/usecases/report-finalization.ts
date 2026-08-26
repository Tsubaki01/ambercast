import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { relativeWithin, relativeWithinOrOriginal } from '#core/paths.js';
import { reportError } from '#report/error-mapping.js';
import { ReportEnvelope, REPORT_SCHEMA_VERSION } from '#report/schema.js';
import { summarizeReport } from '#report/summarize.js';

/**
 * A report envelope that has crossed the command-report finalization boundary.
 *
 * @remarks
 * The brand follows the co-located `NormalizedTestMd` precedent: it makes the
 * boundary visible to TypeScript without changing the object at runtime. It
 * deliberately covers every command branch because validation failure always
 * returns the run-shaped emergency envelope, including for non-run callers.
 * As with that precedent, spreads can lose or recreate the brand in type
 * space, so it is a contract for producers and consumers rather than
 * immutability.
 */
export type FinalizedReportEnvelope = ReportEnvelope & { readonly __brand: 'FinalizedReportEnvelope' };

/*
 * A frozen, private fallback handles schema-validation failure.
 * A fixed value keeps validation details and the original raw report out of
 * the public boundary. The identity check can distinguish this
 * fallback from a valid report with the same visible shape, which structural
 * comparison could misclassify.
 */
const emergencyResults: Extract<ReportEnvelope, { command: 'run' }>['results'] = [];
const emergencySummary = { total: 0, passed: 0, failed: 0, errored: 0, skipped: 0 };
const emergencyErrors: Extract<ReportEnvelope, { command: 'run' }>['errors'] = [
  reportError(
    new UnexpectedCrashError('Report finalization failed schema validation.'),
    { scope: 'run' },
  ),
];

Object.freeze(emergencyResults);
Object.freeze(emergencySummary);
Object.freeze(emergencyErrors[0]);
Object.freeze(emergencyErrors);

const EMERGENCY_ENVELOPE = Object.freeze({
  command: 'run',
  schemaVersion: REPORT_SCHEMA_VERSION,
  startedAt: '1970-01-01T00:00:00Z',
  durationMs: 0,
  reportPersistence: 'not-attempted',
  results: emergencyResults,
  summary: emergencySummary,
  errors: emergencyErrors,
} satisfies Extract<ReportEnvelope, { command: 'run' }>) as FinalizedReportEnvelope;

/**
 * Finalizes a raw command report for every public consumer.
 *
 * @param raw - The unfinalized envelope built by a command report producer.
 * @param projectRoot - The root that defines portable path containment.
 * @returns The branded envelope accepted by command outputs and CLI rendering.
 * @remarks
 * This boundary lives in `usecases/` because it needs core values as well as
 * report contracts; placing it beside report schemas would violate the
 * architecture's value-import boundary while keeping the reporting layer free
 * of forbidden value imports.
 *
 * The pipeline has one fixed order. It rounds per-case `durationMs`
 * with `Math.max(0, Math.round(value))` only for executed `run` and `heal`
 * result rows, and removes a screenshot that cannot be represented as a
 * project-contained POSIX relative path instead of representing it as `null`.
 * It then relativizes only `id`, `file`,
 * `planFile`, `caseId`, `groundingFile`, and `artifactFile`, recomputes the
 * summary from those final identities, and validates the completed candidate.
 * This ordering keeps summaries from observing stale public identities while
 * leaving unexecuted and command-level duration facts intact.
 *
 * Finalization creates a new value rather than mutating `raw`, so applying it
 * again preserves the same visible report. A `safeParse` failure always
 * returns the same frozen emergency-envelope reference, never the invalid
 * candidate or validation details; callers can therefore use identity rather
 * than an unreliable structural match to select the emergency exit policy.
 */
export function finalizeReportEnvelope(
  raw: ReportEnvelope,
  projectRoot: string,
): FinalizedReportEnvelope {
  const durationNormalized = {
    ...raw,
    results: raw.results.map((result) => {
      if ((raw.command !== 'run' && raw.command !== 'heal') || !('durationMs' in result) || !('steps' in result)) {
        return result;
      }

      return {
        ...result,
        durationMs: Number.isFinite(result.durationMs)
          ? Math.max(0, Math.round(result.durationMs))
          : 0,
      };
    }),
  } as ReportEnvelope;
  const screenshotNormalized = {
    ...durationNormalized,
    results: durationNormalized.results.map((result) => {
      if ((durationNormalized.command !== 'run' && durationNormalized.command !== 'heal') || !('steps' in result)) {
        return result;
      }

      return {
        ...result,
        steps: result.steps.map((step) => {
          if (step.screenshot === undefined) return step;
          const screenshot = relativeScreenshot(projectRoot, step.screenshot);
          if (screenshot === undefined) {
            const withoutScreenshot = { ...step };
            delete withoutScreenshot.screenshot;
            return withoutScreenshot;
          }
          return { ...step, screenshot };
        }),
      };
    }),
  } as ReportEnvelope;
  const identityNormalized = {
    ...screenshotNormalized,
    results: screenshotNormalized.results.map((result) => {
      const normalized: Record<string, unknown> = {
        ...result,
        id: relativeWithinOrOriginal(projectRoot, result.id),
        file: relativeWithinOrOriginal(projectRoot, result.file),
      };

      for (const key of ['planFile', 'groundingFile', 'artifactFile'] as const) {
        const value = result[key as keyof typeof result];
        if (typeof value === 'string') normalized[key] = relativeWithinOrOriginal(projectRoot, value);
      }

      return normalized;
    }),
    errors: screenshotNormalized.errors.map((error) => (
      'caseId' in error && typeof error.caseId === 'string'
        ? { ...error, caseId: relativeWithinOrOriginal(projectRoot, error.caseId) }
        : { ...error }
    )),
  } as ReportEnvelope;
  const candidate = {
    ...identityNormalized,
    summary: summarizeReport(identityNormalized),
  };
  const parsed = ReportEnvelope.safeParse(candidate);
  return parsed.success ? candidate as FinalizedReportEnvelope : EMERGENCY_ENVELOPE;
}

function relativeScreenshot(projectRoot: string, screenshot: string): string | undefined {
  const alreadyRelative = relativeWithin('', screenshot);
  if (alreadyRelative !== undefined && !isNonPosixPath(screenshot)) {
    return alreadyRelative;
  }

  return relativeWithin(projectRoot, screenshot);
}

function isNonPosixPath(path: string): boolean {
  return path.includes('\\') || /^[A-Za-z]:/.test(path);
}

/**
 * Reports whether a finalized envelope is the validation-failure fallback.
 *
 * @param envelope - A report that has crossed the finalization boundary.
 * @returns Whether the envelope is the fixed emergency fallback.
 * @remarks
 * The check uses reference identity against the frozen singleton.
 * This avoids treating a legitimate, independently built report as emergency
 * merely because its fields happen to match the fallback's visible shape.
 */
export function isEmergencyFinalizedEnvelope(envelope: FinalizedReportEnvelope): boolean {
  return envelope === EMERGENCY_ENVELOPE;
}
