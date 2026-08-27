import type {
  CheckResult,
  GenerateResult,
  HealResult,
  ReportError,
  ReviewResult,
  RunResult,
  Summary,
} from './schema.js';

/**
 * Command-specific rows accepted by shared report accounting.
 *
 * The command discriminant keeps each result array paired with its own closed
 * public union, so widening one command cannot silently enter another
 * command's classification rules.
 */
export type ReportSummaryInput =
  | {
      readonly command: 'generate';
      readonly results: readonly GenerateResult[];
      readonly errors: readonly ReportError[];
    }
  | {
      readonly command: 'run';
      readonly results: readonly RunResult[];
      readonly errors: readonly ReportError[];
    }
  | {
      readonly command: 'check';
      readonly results: readonly CheckResult[];
      readonly errors: readonly ReportError[];
    }
  | {
      readonly command: 'heal';
      readonly results: readonly HealResult[];
      readonly errors: readonly ReportError[];
    }
  | {
      readonly command: 'review';
      readonly results: readonly ReviewResult[];
      readonly errors: readonly ReportError[];
    };

/**
 * Aggregates visible case identities for one structured report branch.
 *
 * @param input - A command discriminant paired with that command's result
 * union and the shared report-error union.
 * @returns Case counts derived from the final result and case-error identities.
 * @remarks
 * Accounting is identity-based rather than row-based. Results contribute
 * their `id`, case-scoped errors contribute their `caseId`, and run-scoped
 * errors never affect case counts. Repeated rows and a result/error pair for
 * one identity therefore contribute one `total` entry.
 *
 * Classification is promoted monotonically so input order and duplicate rows
 * cannot change the visible count, while a case error overrides prior
 * evidence without inflating the denominator. Exhaustive switches make a new
 * status an explicit accounting decision.
 */
export function summarizeReport(input: ReportSummaryInput): Summary {
  type Classification = 'passed' | 'failed' | 'skipped' | 'errored';
  const ranks: Record<Classification, number> = { passed: 0, failed: 1, skipped: 2, errored: 3 };
  const identities = new Map<string, Classification>();
  const promote = (identity: string, classification: Classification): void => {
    const prior = identities.get(identity);
    if (prior === undefined || ranks[classification] > ranks[prior]) identities.set(identity, classification);
  };
  const assertNever = (value: never): never => { throw new Error(`Unknown report result status: ${String(value)}`); };
  const classifyGenerate = (result: GenerateResult): Classification => {
    switch (result.status) {
      case 'generated': case 'would-generate': case 'skipped-fresh': return 'passed';
      case 'failed': return 'failed'; case 'listed': case 'skipped': return 'skipped';
      default: return assertNever(result);
    }
  };
  const classifyRun = (result: RunResult): Classification => {
    switch (result.status) {
      case 'passed': return 'passed'; case 'failed': return 'failed'; case 'error': return 'errored';
      case 'listed': case 'skipped': return 'skipped'; default: return assertNever(result);
    }
  };
  const classifyCheck = (result: CheckResult): Classification => {
    switch (result.status) {
      case 'fresh': case 'fresh-without-grounding': return 'passed';
      case 'stale': case 'missing-plan': case 'missing-grounding': case 'stale-grounding': case 'invalid-grounding':
      case 'orphaned-plan': case 'orphaned-grounding': case 'invalid-artifact-name': return 'failed';
      case 'listed': case 'skipped': return 'skipped'; default: return assertNever(result);
    }
  };
  /**
   * Classifies a heal row from both repair progress and persistence outcome.
   *
   * Partially healed and unresolved measurements remain failures regardless of
   * application, preserving the established repair guarantee; a declined
   * application is an additional failure condition for an otherwise healed row.
   * Case-scoped errors are promoted separately below, so this function does
   * not duplicate error precedence.
   */
  const classifyHeal = (result: HealResult): Classification => {
    switch (result.status) {
      case 'completed':
        if (result.repairOutcome === 'partially-healed' || result.repairOutcome === 'unresolved') return 'failed';
        if (result.repairOutcome === 'no-changes-needed') return 'passed';
        return result.application === 'applied' || result.application === 'preview-only' ? 'passed' : 'failed';
      case 'listed': case 'skipped': return 'skipped';
      default: return assertNever(result);
    }
  };
  const classifyReview = (result: ReviewResult): Classification => {
    switch (result.status) {
      case 'sufficient': return 'passed'; case 'insufficient': return 'failed'; case 'skipped': return 'skipped';
      default: return assertNever(result);
    }
  };

  switch (input.command) {
    case 'generate': for (const result of input.results) promote(result.id, classifyGenerate(result)); break;
    case 'run': for (const result of input.results) promote(result.id, classifyRun(result)); break;
    case 'check': for (const result of input.results) promote(result.id, classifyCheck(result)); break;
    case 'heal': for (const result of input.results) promote(result.id, classifyHeal(result)); break;
    case 'review': for (const result of input.results) promote(result.id, classifyReview(result)); break;
  }
  for (const error of input.errors) if (error.scope === 'case') promote(error.caseId, 'errored');

  const summary: Summary = { total: identities.size, passed: 0, failed: 0, errored: 0, skipped: 0 };
  for (const classification of identities.values()) summary[classification] += 1;
  return summary;
}
