import type { ReportEnvelope } from '#report/schema.js';
import { relativeWithinOrOriginal } from '#core/paths.js';
import { summarizeReport } from '#report/summarize.js';

/**
 * Produces a project-portable copy of one structured report envelope.
 *
 * @param envelope - Complete command branch to copy and normalize.
 * @param projectRoot - Resolved project root used as the containment boundary.
 * @returns The same command branch with approved identities normalized and its
 * summary recomputed from the final visible identities.
 * @remarks
 * Normalization is deliberately closed to `id`, `file`, `planFile`, `caseId`,
 * `groundingFile`, and `artifactFile`. In-root absolute values become relative;
 * values outside the root, malformed values, and values whose relative form is
 * empty or whitespace retain their original identity. Already-relative values
 * remain stable, making repeated normalization idempotent.
 *
 * The function does not traverse arbitrary user data or rewrite messages,
 * hints, reasons, execution evidence, screenshots, explanations, or review
 * text. It copies the complete envelope and recomputes summary only after path
 * conversion, because two distinct absolute spellings may collapse to one
 * public identity and must still count once.
 */
export function normalizeReportEnvelope<T extends ReportEnvelope>(envelope: T, projectRoot: string): T {
  const normalize = (value: string): string => relativeWithinOrOriginal(projectRoot, value);
  const results = envelope.results.map((result) => {
    const copy: Record<string, unknown> = { ...result, id: normalize(result.id), file: normalize(result.file) };
    for (const key of ['planFile', 'groundingFile', 'artifactFile'] as const) {
      const value = result[key as keyof typeof result];
      if (typeof value === 'string') copy[key] = normalize(value);
    }
    return copy;
  });
  const errors = envelope.errors.map((error) => ('caseId' in error && typeof error.caseId === 'string')
    ? { ...error, caseId: normalize(error.caseId) }
    : { ...error });
  const normalized = { ...envelope, results, errors } as T;
  return { ...normalized, summary: summarizeReport(normalized) } as T;
}
