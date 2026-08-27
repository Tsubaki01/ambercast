/**
 * Defines the local trust policy that turns provider-authored instruction
 * claims into reviewable plan provenance and covered replay evidence.
 *
 * Provider output is never authoritative for source coordinates. Generation
 * resolves verbatim citations against normalized Markdown, derives precise
 * coordinates locally, validate a bounded assertion intent, and discard both
 * the citation text and intent before constructing a plan. Generation
 * freshness checks, `check`, and `run` re-extract the same committed spans, so
 * a schema-valid plan cannot acquire authority from an impossible or
 * hand-edited range.
 *
 * Trace coverage is likewise a local claim rather than proof by itself. The
 * run pipeline fully pre-scans a trace before this policy classifies it as
 * a safe legacy cache miss or a covered replay candidate. A current trace that
 * claims malformed or inconsistent coverage fails closed; only a validated
 * covered trace reaches deterministic replay, which needs no AI call.
 *
 * Generator and agentic prompt policies remain separate consumers of these
 * values. Common injection framing and generator-only citation and intent
 * rules contribute to the generator fingerprint. Agentic-only criterion-tag
 * wording consumes locally trusted criteria but does not stale committed
 * plans. This module supplies data and validation only; it does not compose
 * either prompt.
 */

import type { NormalizedTestMd } from '#core/ir/normalize.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import {
  TraceAssert,
} from '#core/ir/schema.js';
import type {
  GeneratedInstructionCriterion,
  InstructionCriterion,
  JsonValueT,
  RunVariableName,
  TraceRecord,
  TraceRecordWithCoverageStorage,
  VerificationCoverage,
} from '#core/ir/schema.js';
import type {
  AiTrustedInstructionCriterion,
  PreScannedTraceRecord,
  SafeLegacyTraceRecord,
} from '#ports/ai.js';

/** Provider-only fields that generation validates and then separates. */
export interface GeneratedInstructionCoverage {
  /** Cited success and action criteria awaiting local attribution. */
  readonly instructionCoverage: readonly GeneratedInstructionCriterion[];

  /** One transient full assertion intent for every success criterion. */
  readonly verificationIntent: readonly {
    readonly criterionId: string;
    readonly assertion: JsonValueT;
  }[];
}

/**
 * A committed criterion plus text re-extracted from its trusted source span.
 *
 * @remarks
 * Agentic requests consume this local projection instead of provider-authored
 * citations or intent. Re-extraction makes the text and coordinates agree at
 * the boundary where they become trusted prompt metadata. Consumers must not
 * persist `text` as a second source of truth.
 */
export type TrustedInstructionCriterion = AiTrustedInstructionCriterion;

/**
 * Classifies every deterministic instruction-policy failure.
 *
 * @remarks
 * The policy reports issue-like data rather than choosing a public error
 * class. Generation maps provider failures to `AiResponseInvalidError`, check
 * maps committed-policy failure to stale status, and run maps trusted-artifact
 * violations to `IntegrityViolationError`. Keeping that translation at each
 * usecase preserves the existing command-specific error contracts.
 */
export type InstructionCoverageIssueCode =
  | 'citation-whitespace-only'
  | 'citation-not-found'
  | 'citation-not-unique'
  | 'criterion-id-duplicate'
  | 'criterion-range-duplicate'
  | 'criterion-order-invalid'
  | 'source-span-invalid'
  | 'source-span-whitespace-only'
  | 'success-criterion-missing'
  | 'intent-id-duplicate'
  | 'intent-id-missing'
  | 'intent-id-unknown'
  | 'intent-id-action'
  | 'intent-assertion-unsupported'
  | 'terminal-url-matches-forbidden'
  | 'verification-coverage-id-missing'
  | 'verification-coverage-id-unknown'
  | 'verification-coverage-id-action'
  | 'verification-coverage-index-duplicate'
  | 'verification-coverage-index-invalid'
  | 'verification-assertion-repeated';

/** Step-relative roots used by deterministic policy diagnostics. */
export type InstructionCoverageIssuePathRoot =
  | 'instructionCoverage'
  | 'verificationIntent'
  | 'verificationCoverage'
  | 'events'
  | 'verification';

/** One actionable, step-relative failure returned by policy validation. */
export interface InstructionCoverageIssue {
  /** Closed reason code suitable for nonvacuous assertions and caller mapping. */
  readonly code: InstructionCoverageIssueCode;

  /**
   * Path rooted at one field of the containing AI step or trace.
   *
   * Callers prepend their own plan-step, provider-response, or grounding path
   * instead of making the policy depend on an outer document shape.
   */
  readonly path: readonly [InstructionCoverageIssuePathRoot, ...(string | number)[]];

  /** Stable, actionable explanation that does not disclose transient text. */
  readonly message: string;
}

/**
 * A successful policy result or the complete deterministic issue list.
 *
 * @remarks
 * Validation accumulates every independently observable issue for the
 * containing AI step. It sorts paths segment by segment with numbers before
 * strings, numeric segments by value, strings by UTF-16 lexical order, shorter
 * equal prefixes first, and finally the closed issue code. This total order is
 * independent of object prototypes, provider member order, and locale. A
 * validator emits at most one issue for each path-and-code pair, so the final
 * code comparison cannot leave two distinct diagnostics unordered.
 *
 * Complete accumulation is intentional here because coverage is a set of
 * cross-related criteria and assertions and contains no resolved secret data.
 * The secret-attribution policy instead stops at its first failure to preserve
 * grant-claim precedence and give one safe correction target. Applying that
 * first-failure rule here would conceal missing and duplicate members of the
 * same exact-bijection contract.
 */
export type InstructionCoverageResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly issues: readonly InstructionCoverageIssue[] };

declare const COVERED_TRACE_RECORD: unique symbol;

/**
 * A trace whose optional storage extension has been proven present and sound.
 *
 * @remarks
 * `TraceRecord.verificationCoverage` remains optional in storage solely so
 * coverage-less grounding can be parsed during compatibility handling. New
 * persistence and replay require this separately branded type, preventing
 * optionality at rest or pre-scan completion alone from becoming sufficient
 * terminal proof in trusted execution.
 */
export type CoveredTraceRecord = PreScannedTraceRecord<TraceRecord & {
  /** Exact success-criterion-to-terminal-verification index bijection. */
  readonly verificationCoverage: VerificationCoverage;
}> & { readonly [COVERED_TRACE_RECORD]: true };

/** Captured run values that policy code may inspect without external access. */
export interface ReadonlyRunValueProjection {
  /** Captured values keyed by validated run-variable names. */
  readonly values: ReadonlyMap<RunVariableName, string>;
}

/**
 * A non-URL assertion descriptor after trusted run-value substitution.
 *
 * Every serializable field and the original discriminants remain present;
 * only validated interpolatable text has its resolved value substituted.
 * Excluding the URL branch makes its terminal prohibition visible in the
 * comparison type instead of relying on a caller convention. URL assertions
 * remain legal trace events; repetition comparison skips them because no legal
 * non-URL terminal descriptor can equal one.
 */
export type MaterializedNonUrlTraceAssert = Exclude<
  TraceAssert,
  { readonly check: 'url-matches' }
>;

/**
 * Creates the comparison descriptor used to reject repeated terminal proof.
 *
 * @param assertion - Validated non-URL assertion in unresolved trace form.
 * @param runValues - Immutable captured values for trusted substitution.
 * @returns The same discriminated assertion shape with only validated text
 * references substituted.
 * @remarks
 * This synchronous boundary preserves every noninterpolated field, including
 * structured targets and exact counts, and never binds an element. It cannot
 * open a browser, resolve an AI provider, read storage, or mutate run state
 * because its complete dynamic input is the read-only projection. Event and
 * terminal descriptors are compared by serializing both with
 * `toCanonicalArtifactText`; no partial object comparison may replace that
 * canonical whole-value equality.
 */
export function materializeAssertionForCoverage(
  assertion: MaterializedNonUrlTraceAssert,
  runValues: ReadonlyRunValueProjection,
): MaterializedNonUrlTraceAssert {
  const replace = (value: string): string => value.replace(
    /\{\{run\.([A-Za-z0-9_]+)\}\}/g,
    (reference, name: string) => runValues.values.get(name as RunVariableName) ?? reference,
  );

  switch (assertion.check) {
    case 'text-visible':
    case 'text-equals':
      return { ...assertion, text: replace(assertion.text) };
    case 'element-visible':
    case 'element-count':
      return { ...assertion };
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCriteria(left: InstructionCriterion, right: InstructionCriterion): number {
  const leftSpan = left.sourceSpan;
  const rightSpan = right.sourceSpan;
  return leftSpan.startLine - rightSpan.startLine
    || leftSpan.startColumn - rightSpan.startColumn
    || leftSpan.endLine - rightSpan.endLine
    || leftSpan.endColumn - rightSpan.endColumn
    || compareUtf16(left.kind, right.kind)
    || compareUtf16(left.id, right.id);
}

function comparePathSegment(left: string | number, right: string | number): number {
  if (typeof left === 'number') {
    return typeof right === 'number' ? left - right : -1;
  }
  return typeof right === 'number' ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function sortedIssues(issues: InstructionCoverageIssue[]): readonly InstructionCoverageIssue[] {
  const unique = new Map<string, InstructionCoverageIssue>();
  for (const issue of issues) {
    unique.set(`${JSON.stringify(issue.path)}\0${issue.code}`, issue);
  }
  return [...unique.values()].sort((left, right) => {
    const length = Math.min(left.path.length, right.path.length);
    for (let index = 0; index < length; index += 1) {
      const comparison = comparePathSegment(left.path[index]!, right.path[index]!);
      if (comparison !== 0) return comparison;
    }
    return left.path.length - right.path.length
      || compareUtf16(left.code, right.code);
  });
}

function failure(issues: InstructionCoverageIssue[]): InstructionCoverageResult<never> {
  return { success: false, issues: sortedIssues(issues) };
}

function issue(
  code: InstructionCoverageIssueCode,
  path: InstructionCoverageIssue['path'],
): InstructionCoverageIssue {
  return { code, path, message: code };
}

function offsetToPosition(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let previousLf = -1;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 0x0A) {
      line += 1;
      previousLf = index;
    }
  }
  return { line, column: offset - previousLf };
}

function isSurrogateBoundary(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return true;
  const before = source.charCodeAt(offset - 1);
  const after = source.charCodeAt(offset);
  return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF);
}

function extractSpan(
  source: string,
  span: InstructionCriterion['sourceSpan'],
): string | undefined {
  const lines = source.split('\n');
  const toOffset = (line: number, column: number): number | undefined => {
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1 || line > lines.length) {
      return undefined;
    }
    const lineText = lines[line - 1]!;
    if (column > lineText.length + 1) return undefined;
    let offset = 0;
    for (let index = 0; index < line - 1; index += 1) offset += lines[index]!.length + 1;
    offset += column - 1;
    return isSurrogateBoundary(source, offset) ? offset : undefined;
  };
  const start = toOffset(span.startLine, span.startColumn);
  const end = toOffset(span.endLine, span.endColumn);
  if (start === undefined || end === undefined || end <= start) return undefined;
  return source.slice(start, end);
}

/**
 * The only trusted outcomes after a trace has passed the complete safety scan.
 *
 * A legacy trace is recoverable evidence for agentic fallback but is never
 * replayable. A covered trace has passed exact local coverage validation and
 * can proceed to zero-AI replay.
 */
export type PreScannedTraceCoverage =
  | { readonly kind: 'legacy-cache-miss'; readonly priorTrace: SafeLegacyTraceRecord }
  | { readonly kind: 'covered'; readonly trace: CoveredTraceRecord };

/** Inputs needed to validate terminal evidence without external side effects. */
export interface TraceCoverageValidationInput {
  /** Safely pre-scanned trace whose storage coverage is being classified. */
  readonly trace: PreScannedTraceRecord<TraceRecordWithCoverageStorage>;

  /** Locally re-extracted criteria from the containing committed AI step. */
  readonly criteria: readonly TrustedInstructionCriterion[];

  /** Read-only captured values used for semantic assertion comparison. */
  readonly runValues: ReadonlyRunValueProjection;
}

/**
 * Attributes provider citations and validates their transient assertion
 * intents before plan construction.
 *
 * @param generated - Provider-only criteria and terminal assertion intents.
 * @param normalizedTestMd - Canonical prompt in which citations are resolved.
 * @returns Source-ordered committed criteria, or deterministic provider issues.
 * @remarks
 * Citation search counts overlapping exact-substring matches by advancing one
 * UTF-16 code unit at a time. The exact excerpt must contain at least one
 * non-whitespace character, while every interior whitespace code unit remains
 * significant. Exactly one occurrence is required; missing, ambiguous,
 * self-overlapping, fabricated, duplicate-ID, or duplicate-range claims fail.
 * The unique half-open offsets are converted to precise coordinates locally
 * and generated criteria are sorted by start, end, kind, and ID.
 *
 * For any offset `o` from zero through the normalized source length, line is
 * one plus the number of LF code units in `[0, o)`. Let `p` be the greatest LF
 * offset below `o`, or `-1` when none exists; column is `o - p`. Thus an offset
 * on LF is the preceding line's exclusive column, an offset immediately after
 * LF is column one, EOF is always defined, and EOF after a terminal LF is
 * column one of the terminal empty line. Start and end offsets cannot split a
 * surrogate pair.
 *
 * Success IDs and intent IDs form an own-key-safe exact bijection within this
 * AI step. Action, unknown, duplicate, or missing IDs fail, as do unsupported
 * terminal forms and terminal `url-matches`. Exact `element-count` with
 * `count: 0` remains valid; an unbounded minimum-only zero check does not. The
 * successful result contains neither citation text nor intent data.
 */
export function validateGeneratedInstructionCoverage(
  generated: GeneratedInstructionCoverage,
  normalizedTestMd: NormalizedTestMd,
): InstructionCoverageResult<readonly InstructionCriterion[]> {
  const issues: InstructionCoverageIssue[] = [];
  const criteria: InstructionCriterion[] = [];
  const ids = new Set<string>();
  const ranges = new Set<string>();

  for (const [index, candidate] of generated.instructionCoverage.entries()) {
    if (ids.has(candidate.id)) issues.push(issue('criterion-id-duplicate', ['instructionCoverage', index, 'id']));
    ids.add(candidate.id);
    if (!/\S/u.test(candidate.citation)) {
      issues.push(issue('citation-whitespace-only', ['instructionCoverage', index, 'citation']));
      continue;
    }
    const matches: number[] = [];
    for (let start = normalizedTestMd.indexOf(candidate.citation); start !== -1; start = normalizedTestMd.indexOf(candidate.citation, start + 1)) {
      matches.push(start);
    }
    if (matches.length === 0) {
      issues.push(issue('citation-not-found', ['instructionCoverage', index, 'citation']));
      continue;
    }
    if (matches.length !== 1) {
      issues.push(issue('citation-not-unique', ['instructionCoverage', index, 'citation']));
      continue;
    }
    const start = matches[0]!;
    const end = start + candidate.citation.length;
    if (!isSurrogateBoundary(normalizedTestMd, start) || !isSurrogateBoundary(normalizedTestMd, end)) {
      issues.push(issue('source-span-invalid', ['instructionCoverage', index, 'citation']));
      continue;
    }
    const rangeKey = `${start}:${end}`;
    if (ranges.has(rangeKey)) issues.push(issue('criterion-range-duplicate', ['instructionCoverage', index, 'citation']));
    ranges.add(rangeKey);
    const startPosition = offsetToPosition(normalizedTestMd, start);
    const endPosition = offsetToPosition(normalizedTestMd, end);
    criteria.push({
      id: candidate.id,
      kind: candidate.kind,
      sourceSpan: {
        startLine: startPosition.line,
        startColumn: startPosition.column,
        endLine: endPosition.line,
        endColumn: endPosition.column,
      },
    });
  }

  const criterionKinds = new Map<string, 'success' | 'action'>();
  for (const criterion of generated.instructionCoverage) {
    if (!criterionKinds.has(criterion.id)) criterionKinds.set(criterion.id, criterion.kind);
  }
  const successIds = new Set([...criterionKinds].filter(([, kind]) => kind === 'success').map(([id]) => id));
  const actionIds = new Set([...criterionKinds].filter(([, kind]) => kind === 'action').map(([id]) => id));
  if (successIds.size === 0) {
    issues.push(issue('success-criterion-missing', ['instructionCoverage']));
  }
  const intentIds = new Set<string>();
  for (const [index, intent] of generated.verificationIntent.entries()) {
    if (intentIds.has(intent.criterionId)) issues.push(issue('intent-id-duplicate', ['verificationIntent', index, 'criterionId']));
    intentIds.add(intent.criterionId);
    if (actionIds.has(intent.criterionId)) issues.push(issue('intent-id-action', ['verificationIntent', index, 'criterionId']));
    else if (!successIds.has(intent.criterionId)) issues.push(issue('intent-id-unknown', ['verificationIntent', index, 'criterionId']));
    const parsedAssertion = TraceAssert.safeParse(intent.assertion);
    if (parsedAssertion.success && parsedAssertion.data.check === 'url-matches') {
      issues.push(issue('terminal-url-matches-forbidden', ['verificationIntent', index, 'assertion']));
    } else if (!parsedAssertion.success) {
      issues.push(issue('intent-assertion-unsupported', ['verificationIntent', index, 'assertion']));
    }
  }
  for (const id of successIds) {
    if (!intentIds.has(id)) issues.push(issue('intent-id-missing', ['verificationIntent', id]));
  }

  return issues.length > 0 ? failure(issues) : { success: true, data: criteria.sort(compareCriteria) };
}

/**
 * Revalidates committed instruction provenance against the current prompt.
 *
 * @param criteria - Committed criteria for exactly one AI step.
 * @param normalizedTestMd - Current canonical prompt used for re-extraction.
 * @returns Trusted criteria with locally re-extracted text, or policy issues.
 * @remarks
 * Validation rejects empty coverage, missing success criteria, duplicate
 * step-local IDs or ranges, impossible coordinates,
 * reversed or zero-width ranges, out-of-bounds positions, surrogate-splitting
 * boundaries, and a span whose exact re-extraction contains no non-whitespace
 * character. Committed coverage must already have the canonical source, end,
 * kind, and ID order; validation rejects out-of-order committed data instead
 * of silently sorting a reviewed artifact.
 *
 * Generation invokes this boundary before reusing a fresh artifact, `check`
 * invokes it before reporting fresh, and `run` invokes it before browser or AI
 * work. The policy is pure; each caller owns whether failure means regenerate,
 * stale, or integrity violation.
 */
export function validateCommittedInstructionCoverage(
  criteria: readonly InstructionCriterion[],
  normalizedTestMd: NormalizedTestMd,
): InstructionCoverageResult<readonly TrustedInstructionCriterion[]> {
  const issues: InstructionCoverageIssue[] = [];
  const ids = new Set<string>();
  const ranges = new Set<string>();
  const trusted: TrustedInstructionCriterion[] = [];
  for (const [index, criterion] of criteria.entries()) {
    if (ids.has(criterion.id)) issues.push(issue('criterion-id-duplicate', ['instructionCoverage', index, 'id']));
    ids.add(criterion.id);
    const rangeKey = `${criterion.sourceSpan.startLine}:${criterion.sourceSpan.startColumn}:${criterion.sourceSpan.endLine}:${criterion.sourceSpan.endColumn}`;
    if (ranges.has(rangeKey)) issues.push(issue('criterion-range-duplicate', ['instructionCoverage', index, 'sourceSpan']));
    ranges.add(rangeKey);
    const text = extractSpan(normalizedTestMd, criterion.sourceSpan);
    if (text === undefined) issues.push(issue('source-span-invalid', ['instructionCoverage', index, 'sourceSpan']));
    else if (!/\S/u.test(text)) issues.push(issue('source-span-whitespace-only', ['instructionCoverage', index, 'sourceSpan']));
    else trusted.push({ ...criterion, text });
  }
  if (!criteria.some(({ kind }) => kind === 'success')) {
    issues.push(issue('success-criterion-missing', ['instructionCoverage']));
  }
  for (let index = 1; index < criteria.length; index += 1) {
    if (compareCriteria(criteria[index - 1]!, criteria[index]!) > 0
      && !issues.some(({ code }) => code === 'criterion-id-duplicate' || code === 'criterion-range-duplicate')) {
      issues.push(issue('criterion-order-invalid', ['instructionCoverage', index]));
      break;
    }
  }
  return issues.length > 0 ? failure(issues) : { success: true, data: trusted };
}

/**
 * Recognizes the compatibility shape used before verification coverage was
 * persisted with AI traces.
 *
 * @param trace - The raw stored trace whose optional coverage field is being
 * inspected without granting it replay authority.
 * @returns Whether the trace has no usable stored coverage member.
 *
 * @remarks
 * The unbranded storage type lets healing inspect its raw grounding entry;
 * requiring the ports-owned pre-scan brand here would force an unsound cast.
 * The brand is an intersection marker, so the already pre-scanned caller
 * remains assignable without changing its trust boundary.
 *
 * This shape check is intentionally narrower than full coverage validation.
 * Healing uses it only as an inexpensive retrace pre-gate, while execution
 * always repeats the complete safety scan before replay or provider use. A
 * false positive can spend one safe attempt, and a false negative can defer
 * recovery to a later stage; neither result grants an unscanned trace trust.
 */
export function isLegacyShapedTrace(trace: TraceRecord): boolean {
  return !Object.hasOwn(trace, 'verificationCoverage') || trace.verificationCoverage === undefined;
}

/**
 * Classifies terminal coverage only after the run pipeline's safety pre-scan.
 *
 * @param input - Pre-scanned trace, trusted criteria, and pure materializer.
 * @returns A legacy cache miss or a narrowed covered trace, or policy issues
 * for a trace that claims present but invalid coverage.
 * @remarks
 * The caller first distinguishes cold storage from an existing trace, then
 * runs the complete secret, run-reference, and structural pre-scan before
 * calling this function. That ordering prevents unsafe legacy data from being
 * exposed as `priorTrace` to a provider. After pre-scan, absent coverage or an
 * own property whose value is `undefined` is a recoverable normal-mode
 * fallback or cache-only abort; it is never replayed or re-persisted unchanged.
 *
 * Current-provenance data claiming coverage passes raw parse, strict schema,
 * and canonical-byte checks before reaching this typed boundary. Present
 * coverage then requires an own-key-safe exact bijection between every success
 * ID and every verification index, excludes action IDs and terminal
 * `url-matches`, and rejects a terminal assertion semantically repeated from
 * `events`. A URL assertion is legal in events and is skipped by repetition
 * comparison because no legal terminal descriptor can equal it. Invalid
 * coverage fails before browser replay, provider resolution, or cache-only
 * classification. Equality applies
 * {@link materializeAssertionForCoverage} to both event and verification
 * assertions with the supplied read-only run projection, then compares their
 * complete `toCanonicalArtifactText` values. It never uses browser-bound
 * objects, unresolved run text, or a provider-authored descriptor.
 *
 * This policy does not decide agentic success or journal finalization. New
 * traces enter it only after every trailing terminal assertion has exactly one
 * criterion tag. Nominal success ending in a final snapshot or failed
 * assertion remains outside coverage persistence and passes without new
 * grounding under its established cold/fallback mutation rules.
 */
export function classifyPreScannedTraceCoverage(
  input: TraceCoverageValidationInput,
): InstructionCoverageResult<PreScannedTraceCoverage> {
  if (isLegacyShapedTrace(input.trace)) {
    return { success: true, data: { kind: 'legacy-cache-miss', priorTrace: input.trace as SafeLegacyTraceRecord } };
  }
  // `isLegacyShapedTrace` returned false, so the optional storage member is
  // present and defined even though TypeScript cannot infer that fact from a
  // boolean helper.
  const coverage = input.trace.verificationCoverage!;
  const issues: InstructionCoverageIssue[] = [];
  const successIds = new Set(input.criteria.filter(({ kind }) => kind === 'success').map(({ id }) => id));
  const actionIds = new Set(input.criteria.filter(({ kind }) => kind === 'action').map(({ id }) => id));
  const indices = new Set<number>();
  for (const id of successIds) {
    if (!Object.hasOwn(coverage, id)) issues.push(issue('verification-coverage-id-missing', ['verificationCoverage', id]));
  }
  for (const [id, index] of Object.entries(coverage)) {
    if (actionIds.has(id)) issues.push(issue('verification-coverage-id-action', ['verificationCoverage', id]));
    else if (!successIds.has(id)) issues.push(issue('verification-coverage-id-unknown', ['verificationCoverage', id]));
    if (!Number.isInteger(index) || index < 0 || index >= input.trace.verification.length) {
      issues.push(issue('verification-coverage-index-invalid', ['verificationCoverage', id]));
    }
    if (indices.has(index)) issues.push(issue('verification-coverage-index-duplicate', ['verificationCoverage', id]));
    indices.add(index);
  }
  if (!issues.some(({ code }) => code === 'verification-coverage-index-invalid' || code === 'verification-coverage-id-missing')
    && (indices.size !== input.trace.verification.length
      || [...input.trace.verification.keys()].some((index) => !indices.has(index)))) {
    issues.push(issue('verification-coverage-index-invalid', ['verificationCoverage', '\uffff']));
  }

  const eventTexts = new Set<string>();
  for (const event of input.trace.events) {
    if (event.type === 'assert' && event.check !== 'url-matches') {
      eventTexts.add(toCanonicalArtifactText(materializeAssertionForCoverage(event, input.runValues) as never));
    }
  }
  for (const [index, assertion] of input.trace.verification.entries()) {
    if (assertion.check === 'url-matches') {
      issues.push(issue('terminal-url-matches-forbidden', ['verification', index]));
      continue;
    }
    const text = toCanonicalArtifactText(materializeAssertionForCoverage(assertion, input.runValues) as never);
    if (eventTexts.has(text)) issues.push(issue('verification-assertion-repeated', ['verification', index]));
  }
  return issues.length > 0
    ? failure(issues)
    : { success: true, data: { kind: 'covered', trace: input.trace as CoveredTraceRecord } };
}
