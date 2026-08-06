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
 * both representations. Except for duplicate
 * plan-step identifiers (which JSON Schema 2020-12 cannot express), no
 * `.refine()` or `.superRefine()` may encode a constraint that would vanish
 * when this module is converted to JSON Schema.
 *
 * The exported schemas and inferred aliases include the one duplicate-ID
 * `PlanDocument` refinement that JSON Schema cannot express.
 */
import { z } from 'zod';

// A dotted-path resolver must use own-property-safe access (Object.hasOwn or Map), never plain-object bracket access.
const SECRET_REF_PATTERN = /^\{\{secrets\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}\}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
// This flag-independent pattern keeps zod's runtime validator and the generated public JSON Schema aligned: JSON Schema's `pattern` keyword carries no flags, and `z.toJSONSchema()` emits only a regex's source. It rejects a contiguous `{{secrets.` marker at the start of a multi-line string, immediately after an embedded newline, or anywhere later, while accepting a near-miss with a newline inside the marker such as `{{secrets\n.TOKEN}}` because the marker text is not contiguous.
const NO_SECRETS_LITERAL_PATTERN = /^(?![\s\S]*\{\{secrets\.)[\s\S]*$/;
const HTTP_URL_PATTERN = /^https?:\/\/[^\s/?#]\S*$/;
const STEP_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RUN_VARIABLE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const RUN_REF_PATTERN = /^\{\{run\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}\}$/;

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
 * Validates the browser target shared by a plan's `targets` record and
 * `RawConfig.targets`.
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
 */
export const TargetDefinition = z.strictObject({
  baseUrl: z.string().regex(HTTP_URL_PATTERN).regex(NO_SECRETS_LITERAL_PATTERN),
  browser: z.literal('chromium'),
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
 */
export const Fingerprint = z.strictObject({
  algorithm: z.literal('a11y-neighborhood-v1'),
  hash: HexSha256,
});

/**
 * The parsed fingerprint shape associated with a recorded grounding trace.
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
 * literal or embedded token fails {@link SecretRef} validation.
 */
export const FillSecretAction = z.strictObject({
  ...StepBase,
  kind: z.literal('action'),
  action: z.literal('fill-secret'),
  ...FillSecretFields,
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
 */
export const TextVisibleCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('text-visible'),
  text: InterpolatableText,
});

/**
 * The parsed `assert/text-visible` step branch.
 */
export type TextVisibleCheck = z.infer<typeof TextVisibleCheck>;

/**
 * Validates an assertion that a particular element is visible.
 *
 * The element locator keeps visibility checks scoped to a particular target.
 */
export const ElementVisibleCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('element-visible'),
  target: ElementRef,
});

/**
 * The parsed `assert/element-visible` step branch.
 */
export type ElementVisibleCheck = z.infer<typeof ElementVisibleCheck>;

/**
 * Validates an assertion that an element's text equals an expected value.
 *
 * Its expected text remains non-secret by construction, as with other
 * displayable assertion content.
 */
export const TextEqualsCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('text-equals'),
  target: ElementRef,
  text: InterpolatableText,
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
 * tokens.
 */
export const UrlMatchesCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('url-matches'),
  pattern: InterpolatableText,
});

/**
 * The parsed `assert/url-matches` step branch.
 */
export type UrlMatchesCheck = z.infer<typeof UrlMatchesCheck>;

/**
 * Validates an assertion about how many elements match a locator.
 *
 * Zero is a valid and useful expected count; negative and fractional values
 * cannot describe a DOM element count.
 */
export const ElementCountCheck = z.strictObject({
  ...StepBase,
  kind: z.literal('assert'),
  check: z.literal('element-count'),
  target: ElementRef,
  count: z.int().nonnegative(),
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
 * Validates an AI-directed step and its optional recorded fallback trace.
 *
 * Its optional trace preserves a recorded deterministic fallback while
 * applying the same action and secret-reference rules as executable actions.
 */
export const AiStep = z.strictObject({
  ...StepBase,
  kind: z.literal('ai'),
  instruction: InterpolatableText,
  trace: z.lazy(() => Trace).optional(),
});

/**
 * The parsed AI-step branch.
 */
export type AiStep = z.infer<typeof AiStep>;

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
 * Validates the ordered recorded actions attached to grounding or an AI step.
 *
 * An empty trace is structurally valid because usefulness policy belongs
 * outside this trust-boundary schema.
 */
export const Trace = z.array(TraceAction);

/**
 * The parsed ordered list of {@link TraceAction} values.
 */
export type Trace = z.infer<typeof Trace>;

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
 */
export const PlanDocument = z.strictObject({
  schemaVersion: z.literal(1),
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
 * Validates the committed grounding cache associated with one plan digest.
 *
 * Entry keys associate grounding with descriptive plan steps instead of
 * fragile positions, and the plan digest makes stale grounding detectable by
 * provenance validation.
 */
export const GroundingDocument = z.strictObject({
  schemaVersion: z.literal(1),
  planDigest: HexSha256,
  entries: z.record(StepId, z.strictObject({
    fingerprint: Fingerprint,
    trace: Trace.optional(),
  })),
});

/**
 * The parsed grounding cache that records fingerprints and replayable traces
 * for a particular generated plan.
 */
export type GroundingDocument = z.infer<typeof GroundingDocument>;
