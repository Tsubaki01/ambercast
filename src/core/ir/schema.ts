/**
 * Defines ambercast's strict, serializable intermediate-representation
 * documents and the smaller values from which they are assembled.
 *
 * This is the trust boundary between the AI generator, committed plan and
 * grounding artifacts, and deterministic replay. It is deliberately the
 * single runtime source of truth: JSON Schema is derived from these zod
 * schemas, never maintained as a hand-written parallel definition. Strict
 * objects keep zod and the generated JSON Schema aligned on rejecting unknown
 * properties. Structural zod constructs preserve the same constraints across
 * both representations. Except for duplicate plan-step identifiers (which
 * JSON Schema 2020-12 cannot express as projected-field uniqueness across
 * array items) and SourceSpan's endLine/startLine ordering (which it cannot
 * express as a comparison between sibling property values), no `.refine()`
 * or `.superRefine()` may encode a constraint that would vanish when this
 * module is converted to JSON Schema.
 *
 * The exported schemas and inferred aliases include the two deliberate
 * JSON-Schema-inexpressible refinements: duplicate `PlanDocument` IDs and
 * `SourceSpan` endLine/startLine ordering.
 */
import { z } from 'zod';

// A dotted-path resolver must use own-property-safe access (Object.hasOwn or Map), never plain-object bracket access.
/**
 * Matches the unanchored source text of a valid secret reference.
 *
 * Keeping this grammar in one exported fragment prevents generation policy
 * from duplicating the schema's allowed reference syntax. Consumers that scan
 * larger text use it unanchored, while this module anchors it for whole-value
 * validation.
 */
export const SECRET_REF_SOURCE = String.raw`\{\{secrets\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}\}`;
const SECRET_REF_PATTERN = new RegExp(`^${SECRET_REF_SOURCE}$`);
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
// This flag-independent pattern keeps zod's runtime validator and the generated public JSON Schema aligned: JSON Schema's `pattern` keyword carries no flags, and `z.toJSONSchema()` emits only a regex's source. It rejects a contiguous `{{secrets.` marker at the start of a multi-line string, immediately after an embedded newline, or anywhere later, while accepting a near-miss with a newline inside the marker such as `{{secrets\n.TOKEN}}` because the marker text is not contiguous.
const NO_SECRETS_LITERAL_PATTERN = /^(?![\s\S]*\{\{secrets\.)[\s\S]*$/;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]\S*$/;
// Character classes admit only scheme://host[:port], including ports 1–65535, so path/query/fragment/wildcard/userinfo need no `.refine()`; IPv6 literals are deliberately out of scope here while `baseUrl` keeps its separate, more permissive HTTP_URL_PATTERN.
const SECRET_SINK_ORIGIN_PATTERN = /^https?:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*(?::(?:6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[1-5][0-9]{4}|[1-9][0-9]{0,3}))?$/;
const STEP_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RUN_VARIABLE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const RUN_REF_PATTERN = /^\{\{run\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}\}$/;

/**
 * The only Plan IR version accepted or emitted by the instruction-coverage
 * contract.
 *
 * @remarks
 * Plan version 2 changes the plan input-digest preimage. Version 1 plans are
 * regenerated or reported stale at their existing command boundary; they are
 * not migrated in place. Grounding remains version 1 because coverage is an
 * additive optional field nested inside its trace record.
 *
 * Every Plan schema and digest caller shares this literal.
 */
export const PLAN_SCHEMA_VERSION = 2 as const;

/**
 * The unchanged Grounding IR version after trace coverage is added.
 *
 * Grounding construction and validation share this literal.
 */
export const GROUNDING_SCHEMA_VERSION = 1 as const;

/**
 * Validates a whole secret reference.
 *
 * Whole-value references keep secret-bearing fields unambiguous and prevent
 * surrounding prose from carrying a literal secret into logs or traces. A
 * regex instead of a refinement preserves the same restriction in generated
 * JSON Schema.
 */
export const SecretRef = z.string().regex(SECRET_REF_PATTERN);

/**
 * The static value accepted by {@link SecretRef}; consumers should obtain it
 * by parsing untrusted data through the schema rather than casting strings.
 */
export type SecretRef = z.infer<typeof SecretRef>;

/**
 * Validates one configuration-authored HTTP(S) origin permitted to receive a
 * secret value.
 *
 * @remarks
 * Separate `.regex()` calls keep the origin shape and literal-secret ban
 * independently visible in generated JSON Schema. This follows `baseUrl`'s
 * same combination because an origin is authored configuration, not an
 * interpolation target. The schema validates authoring shape only; runtime
 * comparison is parsed and normalized by `URL` in `core/secrets/sink-policy.ts`.
 * Keeping that comparison outside this schema preserves this module's
 * invariant against JSON-Schema-invisible `.refine()` constraints.
 */
export const SecretSinkOrigin = z.string()
  .regex(SECRET_SINK_ORIGIN_PATTERN)
  .regex(NO_SECRETS_LITERAL_PATTERN);

/** The static origin value accepted by {@link SecretSinkOrigin}. */
export type SecretSinkOrigin = z.infer<typeof SecretSinkOrigin>;

/**
 * Validates the canonical lowercase SHA-256 digest encoding used by IR
 * provenance fields.
 *
 * Sharing one schema keeps digest syntax consistent across fields with
 * different provenance roles as the IR evolves.
 */
export const HexSha256 = z.string().regex(HEX_SHA256_PATTERN);

/**
 * The static digest type accepted by {@link HexSha256}.
 */
export type HexSha256 = z.infer<typeof HexSha256>;

/**
 * Validates free text that supports run interpolation without allowing secret
 * interpolation.
 *
 * Generic text only enforces secret safety: capture names and dotted run
 * references have distinct contracts. Keeping this separate from
 * {@link SecretRef} prevents values surfaced in traces, assertions, or
 * generator instructions from embedding secret tokens.
 */
export const InterpolatableText = z.string().regex(NO_SECRETS_LITERAL_PATTERN);

/**
 * The static output type of {@link InterpolatableText}; it represents text
 * that is safe for non-secret IR fields after runtime validation.
 */
export type InterpolatableText = z.infer<typeof InterpolatableText>;

/**
 * Validates the browser target shared by `PlanDocument.targets`,
 * `RawConfig.targets`, and `ResolvedConfig.targets`.
 *
 * A portable regex, rather than `z.url()`, preserves the HTTP(S) restriction
 * in generated JSON Schema without requiring AJV format support. Keeping the
 * browser explicit makes schema evolution visible rather than hiding it in a
 * runtime constant.
 *
 * @remarks
 * A separate `.regex()` composes the HTTP(S) restriction with a
 * secrets-literal check, rather than combining patterns or using `.refine()`.
 * Separate regex constraints remain visible in generated JSON Schema, while a
 * refinement would violate this module's invariant against
 * JSON-Schema-invisible constraints. A `baseUrl` rejects those references
 * because target URLs are human-authored configuration rather than
 * interpolation inputs, preventing unresolved references from entering
 * committed IR or runtime requests.
 *
 * `secretSinkOrigins` follows the same shared-target contract as `baseUrl`
 * and `browser`, so changing it has the existing target-config digest
 * staleness blast radius rather than creating a new cost category. An absent
 * entry for a secret permits fills only at this target's `baseUrl` origin; a
 * present empty array explicitly denies that secret everywhere; and a
 * non-empty array replaces rather than augments the default origin.
 *
 * The field belongs in this shared schema so plans retain the same target
 * snapshot that contributes to freshness, while execution always reads the
 * live `ResolvedConfig` target rather than the plan's copied value. Its
 * values are configuration-authoring shape checks only: the live target is
 * always the runtime authority for allowed origins.
 */
export const TargetDefinition = z.strictObject({
  baseUrl: z.string().regex(HTTP_URL_PATTERN).regex(NO_SECRETS_LITERAL_PATTERN),
  browser: z.literal('chromium'),
  secretSinkOrigins: z.record(SecretRef, z.array(SecretSinkOrigin)).optional(),
});

/**
 * The parsed browser-target shape used by plans and digest inputs.
 */
export type TargetDefinition = z.infer<typeof TargetDefinition>;

/**
 * Validates an accessibility locator.
 *
 * Empty roles or accessible names cannot identify meaningful targets. A
 * separate variant keeps {@link ElementRef} extensible without a
 * shape-breaking redesign.
 */
export const AccessibilityElementRef = z.strictObject({
  strategy: z.literal('accessibility'),
  role: z.string().min(1),
  name: z.string().min(1),
});

/**
 * The parsed accessibility-locator variant of an element reference.
 */
export type AccessibilityElementRef = z.infer<typeof AccessibilityElementRef>;

/**
 * Validates an element locator used by actions, checks, captures, and traces.
 *
 * A one-member strategy union commits callers to selecting a strategy while
 * leaving additional strategies as additive union branches.
 */
export const ElementRef = z.discriminatedUnion('strategy', [AccessibilityElementRef]);

/**
 * The parsed element-reference union, narrowed by its `strategy` field.
 */
export type ElementRef = z.infer<typeof ElementRef>;

/**
 * Validates the stable accessibility-neighborhood fingerprint recorded for a
 * grounding entry.
 *
 * A local neighborhood avoids cache misses from unrelated UI changes. The
 * algorithm identifier makes fingerprint-format changes explicit and
 * versioned.
 *
 * @remarks
 * Only the v2 algorithm literal is accepted. A v1-tagged fingerprint therefore
 * invalidates its whole grounding document during schema validation; grounding
 * loading deliberately treats that validation failure as a full cache-miss
 * fallback rather than a runtime error, so the loader needs no migration path.
 */
export const Fingerprint = z.strictObject({
  algorithm: z.literal('a11y-neighborhood-v2'),
  hash: HexSha256,
});

/**
 * The parsed fingerprint shape recorded for an `element` grounding entry.
 */
export type Fingerprint = z.infer<typeof Fingerprint>;

/**
 * Validates a human-readable, stable plan-step identifier.
 *
 * The leading-letter rule rejects fragile sequential numeric IDs while still
 * allowing descriptive identifiers such as `fill-otp-6-digit-code`.
 */
export const StepId = z.string().regex(STEP_ID_PATTERN);

/**
 * The parsed, schema-valid identifier for a plan step or grounding entry.
 */
export type StepId = z.infer<typeof StepId>;

/**
 * Validates the inclusive line range in the test prompt that authorizes a
 * secret use.
 *
 * The grant grammar uses one physical line, but a range rather than a bare
 * line number accommodates multi-line grant forms without a schema revision.
 * Replay locates the source afresh, so retaining line numbers rather than
 * offsets avoids persisting a second coordinate system that could disagree
 * with the parsed prompt.
 *
 * This is one of this module's two deliberate JSON-Schema-inexpressible
 * refinements: JSON Schema 2020-12 cannot compare sibling property values;
 * the other rejects duplicate `PlanDocument` IDs because it cannot enforce
 * projected-field uniqueness across array items.
 */
export const SourceSpan = z.strictObject({
  startLine: z.int().positive(),
  endLine: z.int().positive(),
}).refine((span) => span.endLine >= span.startLine, {
  message: 'endLine must be greater than or equal to startLine',
  path: ['endLine'],
});

/**
 * The validated source-location range recorded for secret-grant provenance.
 */
export type SourceSpan = z.infer<typeof SourceSpan>;

/**
 * Limits the provider-supplied citation used while attributing a secret grant.
 *
 * The bound contains the work required to inspect untrusted provider output;
 * it is not an authorization boundary. The locally parsed grant and its
 * persisted {@link SourceSpan} provide that authority instead.
 */
const CITATION_MAX_LENGTH = 4096;

/**
 * Validates the exact prompt excerpt a provider supplies for a secret grant.
 *
 * A citation is evidence that deterministic attribution can verify during
 * generation, not evidence replay trusts. Its generous length cap limits an
 * adversarial response's search work without attempting to solve the separate
 * absence of a length cap on {@link SecretRef}.
 */
export const Citation = z.string().min(1).max(CITATION_MAX_LENGTH).describe(
  'The exact, verbatim substring of the test prompt — copied character for ' +
  'character, including whitespace — that shows the @ambercast-secret ' +
  '{{secrets.X}} grant line authorizing this secret reference. Do not ' +
  'paraphrase, summarize, or count lines; copy the text exactly as written.',
);

/**
 * The provider-supplied verbatim prompt excerpt used to locate one secret
 * grant during generation.
 */
export type Citation = z.infer<typeof Citation>;

/**
 * Identifies one instruction criterion within its containing AI step.
 *
 * @remarks
 * The schema uses the same stable-slug grammar as a step identifier, but
 * criterion IDs are step-local because each AI grounding entry owns an
 * independent trace. Consumers use this Zod-derived type instead of
 * maintaining a second grammar in policy code.
 */
export const InstructionCriterionId = z.string().regex(STEP_ID_PATTERN);

/** Runtime schema authority for {@link InstructionCriterionId}. */
export type InstructionCriterionId = z.infer<typeof InstructionCriterionId>;

/** Describes whether an instruction clause is terminal success or directed action. */
export type InstructionCriterionKind = 'success' | 'action';

/**
 * Locates an instruction excerpt precisely in normalized Markdown.
 *
 * @remarks
 * Coordinates are one-based UTF-16 code-unit positions with an exclusive end.
 * This precise range is separate from the line-only {@link SourceSpan} used
 * for grammar-defined secret grants: multiple instruction clauses can share a
 * line and must remain independently re-extractable.
 *
 * A strict Zod object defines the public type. Cross-field coordinate,
 * prompt-boundary, and surrogate checks remain usecase policy because public
 * JSON Schema cannot compare positions against source text.
 */
export const InstructionSourceSpan = z.strictObject({
  startLine: z.int().positive(),
  startColumn: z.int().positive(),
  endLine: z.int().positive(),
  endColumn: z.int().positive(),
});

/** Runtime schema authority for {@link InstructionSourceSpan}. */
export type InstructionSourceSpan = z.infer<typeof InstructionSourceSpan>;

/**
 * A provider-authored instruction claim awaiting local source attribution.
 *
 * The exact citation must contain at least one non-whitespace character while
 * preserving every interior whitespace code unit. Providers cannot submit
 * coordinates because only local normalized-source search may establish
 * persisted provenance.
 */
export const GeneratedInstructionCriterion = z.strictObject({
  id: InstructionCriterionId,
  kind: z.enum(['success', 'action']),
  citation: z.string().min(1),
});

/** Runtime provider schema authority for {@link GeneratedInstructionCriterion}. */
export type GeneratedInstructionCriterion = z.infer<typeof GeneratedInstructionCriterion>;

/**
 * A committed instruction criterion with locally derived source provenance.
 *
 * Provider citations are absent from this shape. The committed span is the
 * only serialized provenance and is re-extracted from the current normalized
 * prompt before it becomes trusted metadata.
 */
export const InstructionCriterion = z.strictObject({
  id: InstructionCriterionId,
  kind: z.enum(['success', 'action']),
  sourceSpan: InstructionSourceSpan,
});

/** Runtime committed schema authority for {@link InstructionCriterion}. */
export type InstructionCriterion = z.infer<typeof InstructionCriterion>;

/**
 * Validates the bare variable name written by a `capture` step.
 *
 * Capture produces an identifier, whereas consumers use a separate reference
 * syntax to read run state.
 */
export const RunVariableName = z.string().regex(RUN_VARIABLE_NAME_PATTERN);

/**
 * The static name emitted by a capture for run-state use.
 */
export type RunVariableName = z.infer<typeof RunVariableName>;

/**
 * Validates a whole `{{run.*}}` consumer reference with one or more dotted
 * alphanumeric-or-underscore path segments.
 *
 * This whole-reference schema stays distinct from generic
 * {@link InterpolatableText}, which enforces secret safety without defining
 * token-level run-reference semantics.
 */
export const RunRef = z.string().regex(RUN_REF_PATTERN);

/**
 * The parsed consumer-side run reference, distinct from a producer-side
 * {@link RunVariableName} even though both ultimately identify run state.
 */
export type RunRef = z.infer<typeof RunRef>;

const StepBase = { id: StepId };
const ClickFields = { target: ElementRef };
const NavigateFields = { url: InterpolatableText };
const PressFields = {
  target: ElementRef,
  key: z.enum(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp']),
};
const FillFields = { target: ElementRef, value: InterpolatableText };
const FillSecretFields = { target: ElementRef, secretRef: SecretRef };
// Provider-facing and committed AI steps share their execution contract; only
// the provenance carried by each secret grant differs. One bundle prevents
// those common fields from drifting across the two representations.
const AiStepFields = {
  ...StepBase,
  kind: z.literal('ai'),
  instruction: InterpolatableText,
};
// Assertion steps and recorded verification use one field contract so an
// assertion cannot change meaning when it moves from a plan into a trace.
const TextVisibleFields = { text: InterpolatableText };
const ElementVisibleFields = { target: ElementRef };
const TextEqualsFields = { target: ElementRef, text: InterpolatableText };
const UrlMatchesFields = { pattern: InterpolatableText };
const ElementCountFields = { target: ElementRef, count: z.int().nonnegative() };

/**
 * Validates an executable `click` action step.
 *
 * Its concrete branch preserves action-specific required fields in the
 * structural nested union, so generated JSON Schema does not need a runtime
 * refinement to express them.
 */
export const ClickAction = z.strictObject({
  ...StepBase,
  kind: z.literal('action'),
  action: z.literal('click'),
  ...ClickFields,
});

/**
 * The parsed `action/click` step branch.
 */
export type ClickAction = z.infer<typeof ClickAction>;

/**
 * Validates an executable `navigate` action step.
 *
 * Navigation is not a secret-bearing operation, so it uses ordinary
 * interpolatable text while retaining that schema's prohibition on embedded
 * secret tokens.
 */
export const NavigateAction = z.strictObject({
  ...StepBase,
  kind: z.literal('action'),
  action: z.literal('navigate'),
  ...NavigateFields,
});

/**
 * The parsed `action/navigate` step branch.
 */
export type NavigateAction = z.infer<typeof NavigateAction>;

/**
 * Validates an executable keyboard `press` action step.
 *
 * Its closed key vocabulary remains small and reviewable, making a new key an
 * explicit schema evolution rather than arbitrary text a replay adapter might
 * not understand.
 */
export const PressAction = z.strictObject({
  ...StepBase,
  kind: z.literal('action'),
  action: z.literal('press'),
  ...PressFields,
});

/**
 * The parsed `action/press` step branch.
 */
export type PressAction = z.infer<typeof PressAction>;

/**
 * Validates an executable non-secret `fill` action step.
 *
 * This branch cannot designate its value as secret. Ordinary literals and
 * run-state text use this path, while secret-bearing input requires the
 * distinct {@link FillSecretAction} branch.
 */
export const FillAction = z.strictObject({
  ...StepBase,
  kind: z.literal('action'),
  action: z.literal('fill'),
  ...FillFields,
});

/**
 * The parsed `action/fill` step branch for non-secret input.
 */
export type FillAction = z.infer<typeof FillAction>;

/**
 * Validates an executable `fill-secret` action step.
 *
 * This dedicated branch is the central structural secret-safety rule: a
 * password cannot masquerade as a secret through a general text field, and a
 * literal or embedded token fails {@link SecretRef} validation. Its grant
 * span remains a flat field because the step already has exactly one secret
 * reference; AI steps need nested pairs to associate each of several
 * references with its own span.
 */
export const FillSecretAction = z.strictObject({
  ...StepBase,
  kind: z.literal('action'),
  action: z.literal('fill-secret'),
  ...FillSecretFields,
  secretGrantSpan: SourceSpan,
});

/**
 * The parsed `action/fill-secret` step branch.
 */
export type FillSecretAction = z.infer<typeof FillSecretAction>;

/**
 * Validates the action half of the plan-step union.
 *
 * Shared field bundles keep plan actions and traces aligned. Concrete nested
 * branches, rather than optional fields or `.superRefine()`, keep zod and the
 * derived JSON Schema aligned on action-specific required fields.
 */
export const ActionStep = z.discriminatedUnion('action', [
  ClickAction,
  NavigateAction,
  PressAction,
  FillAction,
  FillSecretAction,
]);

/**
 * The parsed action-step union narrowed by its `action` discriminant.
 */
export type ActionStep = z.infer<typeof ActionStep>;

/**
 * Validates an assertion that a text value is visible anywhere relevant to
 * the current page.
 *
 * It has no target because text visibility is not an element-locator check.
 * The shared field contract also keeps this plan assertion semantically
 * identical to its trace-verification counterpart.
 */
export const TextVisibleCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('text-visible'),
  ...TextVisibleFields,
});

/**
 * The parsed `assert/text-visible` step branch.
 */
export type TextVisibleCheck = z.infer<typeof TextVisibleCheck>;

/**
 * Validates an assertion that a particular element is visible.
 *
 * The element locator keeps visibility checks scoped to a particular target.
 * Reusing its field contract for recorded verification prevents plan and
 * replay from disagreeing about the evidence a visibility claim requires.
 */
export const ElementVisibleCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('element-visible'),
  ...ElementVisibleFields,
});

/**
 * The parsed `assert/element-visible` step branch.
 */
export type ElementVisibleCheck = z.infer<typeof ElementVisibleCheck>;

/**
 * Validates an assertion that an element's text equals an expected value.
 *
 * Its expected text remains non-secret by construction, as with other
 * displayable assertion content. A shared field contract preserves that
 * secret-safety rule when the assertion is retained as replay evidence.
 */
export const TextEqualsCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('text-equals'),
  ...TextEqualsFields,
});

/**
 * The parsed `assert/text-equals` step branch.
 */
export type TextEqualsCheck = z.infer<typeof TextEqualsCheck>;

/**
 * Validates an assertion that the current URL matches an expected pattern.
 *
 * The expected value is text rather than a URL type because it represents a
 * matching expression and retains the common prohibition on embedded secret
 * tokens. Its shared field contract carries that restriction into recorded
 * verification without a separate trace-only interpretation.
 */
export const UrlMatchesCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('url-matches'),
  ...UrlMatchesFields,
});

/**
 * The parsed `assert/url-matches` step branch.
 */
export type UrlMatchesCheck = z.infer<typeof UrlMatchesCheck>;

/**
 * Validates an assertion about how many elements match a locator.
 *
 * Zero is a valid and useful expected count; negative and fractional values
 * cannot describe a DOM element count. Sharing the field contract with trace
 * verification ensures a replay cannot weaken that numeric boundary.
 */
export const ElementCountCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('element-count'),
  ...ElementCountFields,
});

/**
 * The parsed `assert/element-count` step branch.
 */
export type ElementCountCheck = z.infer<typeof ElementCountCheck>;

/**
 * Validates the assertion half of the plan-step union.
 *
 * Keeping the check discriminator flat avoids an awkward nested property and
 * lets the generated nested `oneOf` describe the valid shapes exactly.
 * Field bundles are shared with trace assertions so executable requirements
 * do not drift from the verification evidence used for replay.
 */
export const AssertStep = z.discriminatedUnion('check', [
  TextVisibleCheck,
  ElementVisibleCheck,
  TextEqualsCheck,
  UrlMatchesCheck,
  ElementCountCheck,
]);

/**
 * The parsed assertion-step union narrowed by its `check` discriminant.
 */
export type AssertStep = z.infer<typeof AssertStep>;

/**
 * Validates a capture step that records an element's value into run state.
 *
 * Capture produces a bare variable identifier; run-state consumers use the
 * distinct reference syntax.
 */
export const CaptureStep = z.strictObject({
  ...StepBase,
  kind: z.literal('capture'),
  target: ElementRef,
  variable: RunVariableName,
});

/**
 * The parsed capture-step branch.
 */
export type CaptureStep = z.infer<typeof CaptureStep>;

/**
 * Validates one secret grant recorded on a committed AI step.
 *
 * Each reference carries the locally derived prompt range that authorized it,
 * preserving distinct grants that happen to use the same secret reference.
 */
export const AiStepSecretGrant = z.strictObject({
  ref: SecretRef,
  sourceSpan: SourceSpan,
});

/**
 * The persisted reference-and-provenance pair for one AI-step secret grant.
 */
export type AiStepSecretGrant = z.infer<typeof AiStepSecretGrant>;

/**
 * Validates an AI-directed step as a pure generation artifact.
 *
 * Keeping execution results outside the plan preserves digest stability. When
 * a previously replayed trace exists, it lives solely in
 * {@link GroundingDocument}. Secret grants are optional rather than defaulted:
 * omission and an explicit empty list both grant nothing at this boundary, but
 * remain distinct serialized values for deterministic digesting. Canonical
 * ordering and omission policy therefore belong before this schema is used to
 * persist a generated plan, not in validation.
 */
export const AiStep = z.strictObject({
  ...AiStepFields,
  secrets: z.array(AiStepSecretGrant).optional(),
  instructionCoverage: z.array(InstructionCriterion).min(1),
});

/**
 * The parsed AI-step branch, preserving the distinction between omitted
 * secret grants and an explicitly empty list.
 */
export type AiStep = z.infer<typeof AiStep>;

/**
 * The Plan-v2 AI-step contract with required instruction coverage.
 *
 * @remarks
 * This consumer-facing alias preserves the required non-empty field already
 * enforced by {@link AiStep}; it is not a second runtime authority.
 */
export type InstructionCoveredAiStep = AiStep & {
  /** Locally attributed success and action criteria in canonical source order. */
  readonly instructionCoverage: readonly InstructionCriterion[];
};

/**
 * Validates one ordered instruction in a generated plan.
 *
 * Fully enumerated nested branches let JSON Schema express the same action-
 * and check-specific required fields instead of relying on refinements that
 * only zod can execute.
 */
export const Step = z.discriminatedUnion('kind', [ActionStep, AssertStep, CaptureStep, AiStep]);

/**
 * The parsed outer step union narrowed by its `kind` discriminant.
 */
export type Step = z.infer<typeof Step>;

/** The Plan-v2 step union with instruction-covered AI branches. */
export type InstructionCoveredStep = Step;

/**
 * Validates a provider-authored `fill-secret` action before local attribution.
 *
 * Providers supply a verbatim citation rather than a source span because only
 * local prompt parsing may establish the persisted authorization provenance.
 */
export const GeneratedFillSecretAction = z.strictObject({
  ...StepBase,
  kind: z.literal('action'),
  action: z.literal('fill-secret'),
  ...FillSecretFields,
  citation: Citation,
});

/**
 * The provider-facing `action/fill-secret` branch awaiting local attribution.
 */
export type GeneratedFillSecretAction = z.infer<typeof GeneratedFillSecretAction>;

/**
 * Validates the action portion of a provider-authored step response.
 *
 * Non-secret branches already match their committed representations, while
 * the secret branch preserves its citation until local verification replaces
 * it with a source span.
 */
export const GeneratedActionStep = z.discriminatedUnion('action', [
  ClickAction,
  NavigateAction,
  PressAction,
  FillAction,
  GeneratedFillSecretAction,
]);

/**
 * The provider-facing action union narrowed by its `action` discriminant.
 */
export type GeneratedActionStep = z.infer<typeof GeneratedActionStep>;

/**
 * Validates one provider-authored AI-step secret grant before local
 * attribution.
 *
 * The provider pairs its reference with the prompt text it copied, allowing
 * local code to reject an ambiguous or non-grant citation before persistence.
 */
export const GeneratedAiStepSecretGrant = z.strictObject({
  ref: SecretRef,
  citation: Citation,
});

/**
 * The provider-facing reference-and-citation pair for one AI-step grant.
 */
export type GeneratedAiStepSecretGrant = z.infer<typeof GeneratedAiStepSecretGrant>;

/**
 * Validates a provider-authored AI step before local secret-grant attribution.
 *
 * The shared AI-step fields remain identical to the committed step, leaving
 * each secret entry's citation as the only provider-facing provenance.
 */
export const GeneratedAiStep = z.strictObject({
  ...AiStepFields,
  secrets: z.array(GeneratedAiStepSecretGrant).optional(),
  instructionCoverage: z.array(GeneratedInstructionCriterion).min(1),
  verificationIntent: z.array(z.lazy(() => VerificationIntent)).min(1),
});

/**
 * The provider-facing AI-step branch awaiting local attribution.
 */
export type GeneratedAiStep = z.infer<typeof GeneratedAiStep>;

/**
 * A full provider-only assertion proposal for one named success criterion.
 *
 * @remarks
 * The assertion is a bounded representability claim, not semantic proof. It
 * is discarded after generation validates the exact success-ID bijection and
 * never enters Plan IR, agentic metadata, or grounding. A strict Zod object
 * validates this provider-only interface.
 */
export interface VerificationIntent {
  /** Success criterion for which the provider proposes terminal evidence. */
  readonly criterionId: InstructionCriterionId;

  /** Complete assertion from the supported serializable vocabulary. */
  readonly assertion: TraceAssert;
}

/** Runtime provider schema authority for {@link VerificationIntent}. */
export const VerificationIntent: z.ZodType<VerificationIntent> = z.lazy(() => z.strictObject({
  criterionId: InstructionCriterionId,
  assertion: TraceAssert,
}));

/**
 * The provider AI-step shape carrying citations and transient verification
 * intents.
 *
 * @remarks
 * This consumer-facing alias reflects both required arrays already enforced
 * by {@link GeneratedAiStep}, the single provider-shape authority.
 */
export type GeneratedInstructionCoveredAiStep = GeneratedAiStep & {
  /** Non-empty provider citations awaiting local attribution. */
  readonly instructionCoverage: readonly GeneratedInstructionCriterion[];

  /** One full transient assertion intent for every success criterion. */
  readonly verificationIntent: readonly VerificationIntent[];
};

/**
 * Validates one complete provider-authored step before locally deterministic
 * fields are assembled into a committed plan.
 *
 * Assertions and captures require no secret provenance and therefore reuse
 * their committed shapes without a parallel schema branch.
 */
export const GeneratedStep = z.discriminatedUnion('kind', [
  GeneratedActionStep,
  AssertStep,
  CaptureStep,
  GeneratedAiStep,
]);

/**
 * The provider-facing outer step union narrowed by its `kind` discriminant.
 */
export type GeneratedStep = z.infer<typeof GeneratedStep>;

/**
 * Validates a recorded `click` trace action.
 *
 * It reuses executable-click target semantics while keeping trace records
 * distinct from plan-step identification.
 */
export const TraceClick = z.strictObject({
  type: z.literal('click'),
  ...ClickFields,
});

/**
 * The parsed `click` branch of a grounding trace.
 */
export type TraceClick = z.infer<typeof TraceClick>;

/**
 * Validates a recorded `navigate` trace action.
 *
 * Recorded navigation retains the same secret-token exclusion as executable
 * navigation.
 */
export const TraceNavigate = z.strictObject({
  type: z.literal('navigate'),
  ...NavigateFields,
});

/**
 * The parsed `navigate` branch of a grounding trace.
 */
export type TraceNavigate = z.infer<typeof TraceNavigate>;

/**
 * Validates a recorded keyboard `press` trace action.
 *
 * Sharing {@link PressAction}'s closed vocabulary prevents replay recordings
 * from expanding the executable behavior silently.
 */
export const TracePress = z.strictObject({
  type: z.literal('press'),
  ...PressFields,
});

/**
 * The parsed `press` branch of a grounding trace.
 */
export type TracePress = z.infer<typeof TracePress>;

/**
 * Validates a recorded non-secret `fill` trace action.
 *
 * Grounding traces are committed data, so this action receives the same
 * secret-token exclusion as the live fill action.
 */
export const TraceFill = z.strictObject({
  type: z.literal('fill'),
  ...FillFields,
});

/**
 * The parsed non-secret `fill` branch of a grounding trace.
 */
export type TraceFill = z.infer<typeof TraceFill>;

/**
 * Validates a recorded secret fill trace action.
 *
 * Grounding traces are committed, so recording a password keystroke preserves
 * a reference rather than its literal value.
 */
export const TraceFillSecret = z.strictObject({
  type: z.literal('fill-secret'),
  ...FillSecretFields,
});

/**
 * The parsed secret `fill-secret` branch of a grounding trace.
 */
export type TraceFillSecret = z.infer<typeof TraceFillSecret>;

/**
 * Validates one action in a grounding trace.
 *
 * Shared field bundles mirror action-step bundles so plans and traces cannot
 * drift on the meaning of an executable verb.
 */
export const TraceAction = z.discriminatedUnion('type', [
  TraceClick,
  TraceNavigate,
  TracePress,
  TraceFill,
  TraceFillSecret,
]);

/**
 * The parsed trace-action union narrowed by its `type` discriminant.
 */
export type TraceAction = z.infer<typeof TraceAction>;

/**
 * Validates an assertion observation retained in an AI trace.
 *
 * Assertion traces use the same two discriminator levels as plan assertions:
 * the outer trace category keeps them distinct from executable actions, while
 * the check branch selects its required evidence fields. Reusing the plan
 * field bundles prevents a recorded verification from accepting a shape that
 * the equivalent plan assertion rejects, and strict branches keep every
 * requirement visible to generated JSON Schema.
 *
 * Criterion identifiers deliberately do not belong to this serializable
 * union. Agentic controllers carry the optional tag as separate journal
 * metadata so replay assertions retain one stable public shape.
 */
export const TraceAssert = z.discriminatedUnion('check', [
  z.strictObject({
    type: z.literal('assert'),
    check: z.literal('text-visible'),
    ...TextVisibleFields,
  }),
  z.strictObject({
    type: z.literal('assert'),
    check: z.literal('element-visible'),
    ...ElementVisibleFields,
  }),
  z.strictObject({
    type: z.literal('assert'),
    check: z.literal('text-equals'),
    ...TextEqualsFields,
  }),
  z.strictObject({
    type: z.literal('assert'),
    check: z.literal('url-matches'),
    ...UrlMatchesFields,
  }),
  z.strictObject({
    type: z.literal('assert'),
    check: z.literal('element-count'),
    ...ElementCountFields,
  }),
]);

/**
 * The parsed assertion-observation union narrowed by its `check`
 * discriminant.
 */
export type TraceAssert = z.infer<typeof TraceAssert>;

/**
 * Validates one chronological entry in an AI trace.
 *
 * A single outer discriminator gives the trace an ordered journal containing
 * both actions and observations without blurring their different replay
 * roles. Its structural branches deliberately replace optional payload
 * fields or refinement logic, preserving the same contract in JSON Schema.
 */
export const TraceEntry = z.discriminatedUnion('type', [TraceAction, TraceAssert]);

/**
 * The parsed chronological trace-entry union narrowed by its `type`
 * discriminant.
 */
export type TraceEntry = z.infer<typeof TraceEntry>;

/**
 * Validates the replayable journal recorded for an AI-directed step.
 *
 * Event history can be empty when an agent needs only to observe and verify
 * the page, but replayable success requires at least one verification
 * assertion. The minimum is structural rather than a refinement so derived
 * JSON Schema preserves the requirement. Keeping event history and terminal
 * verification in one shared record prevents grounding storage and agentic
 * replay inputs from growing independent, subtly different trace shapes.
 */
export const TraceRecord = z.strictObject({
  events: z.array(TraceEntry),
  verification: z.array(TraceAssert).min(1),
  verificationCoverage: z.record(InstructionCriterionId, z.int().nonnegative()).optional(),
});

/**
 * The parsed replayable AI-trace record, including its non-empty terminal
 * verification evidence.
 */
export type TraceRecord = z.infer<typeof TraceRecord>;

/** Criterion-to-terminal-verification indices stored in canonical trace data. */
export const VerificationCoverage = z.record(InstructionCriterionId, z.int().nonnegative());

/** Runtime schema authority for {@link VerificationCoverage}. */
export type VerificationCoverage = z.infer<typeof VerificationCoverage>;

/**
 * The additive Grounding-v1 trace storage shape.
 *
 * @remarks
 * Optionality exists only so coverage-less historical traces remain
 * parseable. It does not make proof optional for newly persisted or replayed
 * traces. {@link TraceRecord} owns the optional storage field directly; this
 * alias names that compatibility boundary without creating another authority.
 */
export type TraceRecordWithCoverageStorage = TraceRecord;

/**
 * Validates grounding recorded for an element-based action, assertion, or
 * capture step.
 *
 * Element grounding retains a stable accessibility-neighborhood fingerprint
 * without implying that the step has an AI execution trace.
 */
export const ElementGroundingEntry = z.strictObject({
  kind: z.literal('element'),
  fingerprint: Fingerprint,
});

/**
 * The parsed `element` branch of a grounding entry.
 */
export type ElementGroundingEntry = z.infer<typeof ElementGroundingEntry>;

/**
 * Validates grounding recorded for an AI-directed step.
 *
 * Requiring a complete trace makes an `ai` entry evidence of a successful
 * agentic execution; an absent record expresses that no trace has been
 * recorded yet. Its events may be empty only when verification is non-empty;
 * an empty verification list, including a record with both lists empty, is
 * invalid. As a strict object, the entry also rejects unknown keys, keeping
 * all four trace-container boundary cases explicit and portable to JSON
 * Schema.
 */
export const AiGroundingEntry = z.strictObject({
  kind: z.literal('ai'),
  trace: TraceRecord,
});

/**
 * The parsed `ai` grounding branch with replayable terminal verification.
 */
export type AiGroundingEntry = z.infer<typeof AiGroundingEntry>;

/**
 * Validates the distinct grounding records for element-based and AI-directed
 * steps.
 *
 * The discriminator prevents a fingerprint and an AI trace from sharing one
 * entry, keeping their provenance and replay roles unambiguous.
 */
export const GroundingEntry = z.discriminatedUnion('kind', [
  ElementGroundingEntry,
  AiGroundingEntry,
]);

/**
 * The parsed grounding-entry union narrowed by its `kind` discriminant.
 */
export type GroundingEntry = z.infer<typeof GroundingEntry>;

/**
 * Represents every value that can exist in RFC 8259 JSON and therefore in a
 * serializable generator-metadata record.
 *
 * The recursive definition deliberately excludes `undefined`, bigint,
 * functions, symbols, and other JavaScript-only values before they can reach
 * canonical JSON serialization. Cycles are not separately detected: real IR
 * documents originate from parsed JSON and therefore cannot be cyclic; a
 * hand-constructed cyclic test double is a caller error, not a product input
 * this schema needs a special traversal solely to reject.
 */
export type JsonValueT =
  | string
  | number
  | boolean
  | null
  | JsonValueT[]
  | { [key: string]: JsonValueT };

/**
 * Validates {@link JsonValueT} recursively for `generatorMeta` values.
 *
 * The explicit `z.ZodType<JsonValueT>` annotation breaks TypeScript's
 * self-referential inference cycle. `z.unknown()` would admit values that
 * cannot live in a committed JSON artifact.
 */
export const JsonValue: z.ZodType<JsonValueT> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(JsonValue),
  z.record(z.string(), JsonValue),
]));

/**
 * Validates the complete generated plan document that is reviewed and
 * committed beside its source test prompt.
 *
 * Duplicate step IDs are the sole semantic rule outside JSON Schema: projected
 * uniqueness cannot be expressed by `uniqueItems`, which compares complete
 * values. The refinement reports a duplicate at the later step's ID so the
 * generator can direct a repair to the offending location.
 *
 * The instruction-coverage implementation accepts and emits only literal
 * version 2. That version enters `inputsDigest`; version 1 is rejected rather
 * than retained as a compatibility union branch.
 */
export const PlanDocument = z.strictObject({
  schemaVersion: z.literal(PLAN_SCHEMA_VERSION),
  source: z.strictObject({ inputsDigest: HexSha256 }),
  generatorMeta: z.record(z.string(), JsonValue).optional(),
  targets: z.record(z.string(), TargetDefinition),
  steps: z.array(Step),
}).superRefine((plan, ctx) => {
  const seen = new Set<string>();

  for (const [index, step] of plan.steps.entries()) {
    if (seen.has(step.id)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate step id: ${step.id}`,
        path: ['steps', index, 'id'],
      });
    }
    seen.add(step.id);
  }
});

/**
 * The parsed generated plan used for canonical serialization and digest
 * computation. Callers must not hand-edit an IR object to bypass validation.
 */
export type PlanDocument = z.infer<typeof PlanDocument>;

/**
 * Complete Plan-v2 shape at the instruction-coverage boundary.
 *
 * @remarks
 * {@link PlanDocument} itself uses literal version 2 and derives its static
 * type from Zod. Version 1 is not a union branch and therefore has no
 * compatibility path through Plan validation.
 */
export type InstructionCoveredPlanDocument = PlanDocument;

/**
 * Validates only the provider-authored portion of a generated plan response.
 *
 * Provider output deliberately excludes local provenance, target selection,
 * and schema versioning. The generation use case adds those deterministic
 * fields before validating the completed {@link PlanDocument}, preserving the
 * provider boundary's smaller and more trustworthy responsibility.
 */
export const GeneratedPlanResponse = z.strictObject({
  steps: z.array(GeneratedStep),
  generatorMeta: z.record(z.string(), JsonValue).optional(),
  ambiguities: z.array(JsonValue),
});

/**
 * The validated, provider-authored portion from which a complete plan is
 * assembled locally.
 */
export type GeneratedPlanResponse = z.infer<typeof GeneratedPlanResponse>;

/** The provider step union with required coverage fields on every AI branch. */
export type GeneratedInstructionCoveredStep =
  | Exclude<GeneratedStep, GeneratedAiStep>
  | GeneratedInstructionCoveredAiStep;

/**
 * Provider response shape used to construct Plan v2.
 *
 * {@link GeneratedPlanResponse} validates the covered step union before
 * generation policy examines citations or intent.
 */
export type GeneratedInstructionCoveredPlanResponse = Omit<
  GeneratedPlanResponse,
  'steps'
> & {
  readonly steps: readonly GeneratedInstructionCoveredStep[];
};

/**
 * Validates the committed grounding cache associated with one plan digest.
 *
 * Entry keys associate grounding with descriptive plan steps instead of
 * fragile positions, while the plan digest makes stale grounding detectable
 * by provenance validation. Grounding is the sole authority for an AI step's
 * trace: {@link AiStep} has no execution-result field, and only an `ai` entry
 * records its trace.
 *
 * A run-pipeline implementation must leave an entry unchanged after
 * successfully replaying its existing trace, must write a new `ai` entry —
 * creating one where none exists or overwriting an existing one — after a
 * successful `executeAgentic` call, and must leave any existing entry
 * untouched when `executeAgentic` fails or aborts. This preserves a
 * previously good trace and prevents a failed or partial execution from
 * becoming replay data.
 *
 * Grounding keeps literal version 1 when instruction coverage is installed.
 * Compatibility lives only in the optional nested trace mapping; it does not
 * introduce a second document version or weaken Plan-v2 freshness.
 */
export const GroundingDocument = z.strictObject({
  schemaVersion: z.literal(GROUNDING_SCHEMA_VERSION),
  planDigest: HexSha256,
  entries: z.record(StepId, GroundingEntry),
});

/**
 * The parsed grounding cache for a particular generated plan.
 */
export type GroundingDocument = z.infer<typeof GroundingDocument>;

/** AI grounding entry whose trace may carry additive coverage storage. */
export type AiGroundingEntryWithCoverageStorage = Omit<AiGroundingEntry, 'trace'> & {
  /** Legacy-compatible trace storage before semantic coverage narrowing. */
  readonly trace: TraceRecordWithCoverageStorage;
};

/** Grounding entry union with coverage-aware AI trace storage. */
export type GroundingEntryWithCoverageStorage =
  | Exclude<GroundingEntry, AiGroundingEntry>
  | AiGroundingEntryWithCoverageStorage;

/**
 * Grounding-v1 projection after strict coverage-aware schema validation.
 *
 * @remarks
 * This projection retains document version 1 and names the nested AI trace
 * extension already owned by {@link TraceRecord}. The Zod-inferred
 * {@link GroundingDocument} remains the sole runtime authority.
 */
export type GroundingDocumentWithCoverageStorage = GroundingDocument;
