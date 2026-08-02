/**
 * Defines ambercast's strict, serializable intermediate-representation
 * documents and the smaller values from which they are assembled.
 *
 * This is the trust boundary between the AI compiler, committed plan and
 * grounding artifacts, and deterministic replay. It is deliberately the
 * single runtime source of truth: JSON Schema is derived from these zod
 * schemas, never maintained as a hand-written parallel definition. The
 * implementation uses `z.strictObject` for every object so zod
 * and the generated JSON Schema agree that unknown properties are invalid.
 * It must also use structural zod constructs such as regexes, literals,
 * strict objects, arrays, records, discriminated unions, recursive lazies,
 * ordinary unions, enums, optionals, and numeric bounds. Except for duplicate
 * plan-step identifiers (which JSON Schema 2020-12 cannot express), no
 * `.refine()` or `.superRefine()` may encode a constraint that would vanish
 * when this module is converted to JSON Schema.
 *
 * The schemas preserve the documented export surface and inferred aliases,
 * including the one duplicate-ID `PlanDocument` refinement that JSON Schema
 * cannot express.
 */
import { z } from 'zod';

const SECRET_REF_PATTERN = /^\{\{secrets\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}\}$/;
const HEX_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTERPOLATABLE_TEXT_PATTERN = /^(?!.*\{\{secrets\.).*$/s;
const HTTP_URL_PATTERN = /^https?:\/\/\S+$/;
const STEP_ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const RUN_VARIABLE_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const RUN_REF_PATTERN = /^\{\{run\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}\}$/;

/**
 * Validates a whole secret reference such as `{{secrets.production.password}}`.
 *
 * Secret-bearing fields use this schema exclusively rather than accepting a
 * reference inside general text. Its regex is
 * `/^\{\{secrets\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*\}\}$/`: it requires the
 * complete string to be one `secrets` path, requires at least one path
 * segment, and permits only letters, digits, and underscores per segment.
 * Whole-string matching is essential because surrounding prose could carry a
 * literal secret into logs or traces. A regex, rather than a refinement,
 * deliberately becomes the same `pattern` constraint in generated JSON
 * Schema.
 */
export const SecretRef = z.string().regex(SECRET_REF_PATTERN);

/**
 * The static value accepted by {@link SecretRef}; consumers should obtain it
 * by parsing untrusted data through the schema rather than casting strings.
 */
export type SecretRef = z.infer<typeof SecretRef>;

/**
 * Validates the canonical lowercase SHA-256 digest encoding shared by IR
 * provenance fields.
 *
 * Its regex is `/^[0-9a-f]{64}$/`. {@link Fingerprint},
 * {@link PlanDocument}, and {@link GroundingDocument} reuse this schema for
 * fields with different provenance roles, so one definition prevents their
 * shared digest syntax from drifting during schema evolution.
 */
export const HexSha256 = z.string().regex(HEX_SHA256_PATTERN);

/**
 * The static digest type accepted by {@link HexSha256}.
 */
export type HexSha256 = z.infer<typeof HexSha256>;

/**
 * Validates free text that may interpolate `{{run.*}}` values but may never
 * contain the literal substring `{{secrets.`.
 *
 * Its dot-all negative-lookahead regex is
 * `/^(?!.*\{\{secrets\.).*$/s`. It intentionally does not attempt to parse or
 * validate allowed run references yet: a capture produces a bare variable
 * name while a future run reference can be a dotted path, and token-level
 * validation belongs to that later feature. Its narrow job now is preventing
 * secret tokens from being embedded into values that can be surfaced in
 * traces, assertions, or compiler instructions. This is never unioned with
 * `SecretRef`; secret values are admitted only by a `fill-secret` variant.
 */
export const InterpolatableText = z.string().regex(INTERPOLATABLE_TEXT_PATTERN);

/**
 * The static output type of {@link InterpolatableText}; it represents text
 * that is safe for non-secret IR fields after runtime validation.
 */
export type InterpolatableText = z.infer<typeof InterpolatableText>;

/**
 * Validates the browser target named by a plan's `targets` record.
 *
 * This schema is a strict object with `baseUrl` and `browser`. `baseUrl`
 * uses `/^https?:\/\/\S+$/`, not `z.url()`: zod emits `z.url()` as a bare URI
 * format, which requires AJV format support and loses the HTTP(S)-only
 * restriction during JSON Schema generation. The explicit regex has identical
 * zod and JSON Schema meaning. `browser` is the literal `'chromium'` for the
 * MVP, but remains a field so future browser support can evolve visibly with
 * a schema-version change instead of being a hidden runtime constant.
 */
export const TargetDefinition = z.strictObject({
  baseUrl: z.string().regex(HTTP_URL_PATTERN),
  browser: z.literal('chromium'),
});

/**
 * The parsed target shape used by plans and by the later digest input record.
 */
export type TargetDefinition = z.infer<typeof TargetDefinition>;

/**
 * Validates the currently supported accessibility locator.
 *
 * It is a strict `{ strategy: 'accessibility', role, name }` object whose
 * `role` and `name` are non-empty strings. An empty role or accessible name
 * cannot identify a meaningful target. It is kept as its own schema so
 * `ElementRef` can remain a discriminated union when new locating strategies
 * are added, rather than requiring a shape-breaking redesign.
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
 * This schema is a discriminated union on `strategy` containing
 * the one {@link AccessibilityElementRef} variant today. A one-member union
 * is intentional: it commits callers to selecting a strategy now while
 * allowing an additional strategy later as an additive union branch.
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
 * This strict object has algorithm literal `'a11y-neighborhood-v1'` and
 * `hash: {@link HexSha256}`. This captures a local neighborhood rather than a
 * page-wide hash, avoiding cache misses from unrelated UI changes. Naming the
 * algorithm makes a future fingerprint-format change explicit and versioned.
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
 * Its regex is `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`: identifiers begin
 * with a lowercase letter, then use lowercase letters and digits in
 * hyphen-separated slug segments. The leading-letter rule deliberately
 * rejects sequential numeric IDs such as `1` and `1-2`, while allowing an
 * intentional descriptive ID such as `fill-otp-6-digit-code`.
 */
export const StepId = z.string().regex(STEP_ID_PATTERN);

/**
 * The parsed, schema-valid identifier for a plan step or grounding entry.
 */
export type StepId = z.infer<typeof StepId>;

/**
 * Validates the bare variable name written by a `capture` step.
 *
 * Its regex is `/^[a-z][a-zA-Z0-9]*$/`, which makes the producer
 * name start with lowercase ASCII and then permits alphanumerics. It is not a
 * `{{run.*}}` reference: capture creates the identifier, whereas consumers
 * later read values through a separate reference syntax.
 */
export const RunVariableName = z.string().regex(RUN_VARIABLE_NAME_PATTERN);

/**
 * The static name emitted by a capture and available for later run-state use.
 */
export type RunVariableName = z.infer<typeof RunVariableName>;

/**
 * Validates a whole `{{run.*}}` consumer reference with one or more dotted
 * alphanumeric-or-underscore path segments.
 *
 * Its regex mirrors `SecretRef` but uses the `run` prefix. This schema
 * is reserved for the later token-level interpolation feature; current
 * {@link InterpolatableText} fields intentionally allow run-token-shaped
 * text without invoking it. That asymmetry lets the present schema prevent
 * secret leakage without falsely defining future run-reference semantics.
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
 * This strict object combines `{ id: StepId, kind: 'action', action:
 * 'click' }` with the shared `target: ElementRef` action-field bundle. The
 * concrete branch is separate so `ActionStep` can use a structural nested
 * discriminated union, preserving action-specific required fields in JSON
 * Schema without a runtime refinement.
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
 * Its strict shape is `{ id, kind: 'action', action: 'navigate', url }`
 * with `url` validated by {@link InterpolatableText}. Navigation is not a
 * secret-bearing operation, so it may use ordinary interpolatable text but
 * inherits that schema's structural prohibition on embedded secret tokens.
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
 * Its strict shape carries an element `target` plus a closed `key` enum:
 * `Enter`, `Tab`, `Escape`, `ArrowDown`, or `ArrowUp`. The MVP vocabulary is
 * deliberately small and reviewable; a new key is an explicit additive
 * schema evolution rather than arbitrary text that a replay adapter may not
 * understand.
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
 * Its strict shape carries `target` and `value: InterpolatableText`.
 * This branch is intentionally unable to declare that its value is secret:
 * users can fill ordinary literals or run-state text here, but selecting the
 * secret-bearing operation requires the different {@link FillSecretAction}
 * branch and its exact reference syntax.
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
 * Its strict shape is `{ id, kind: 'action', action: 'fill-secret',
 * target, secretRef }`, where `secretRef` is exactly {@link SecretRef}. It
 * has no general `value` field. This dedicated branch is the central
 * structural secret-safety rule: a password has no legal field in which to
 * masquerade as a secret, and an embedded token or literal fails the
 * whole-string secret-reference pattern.
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
 * This schema discriminates on `action` across the five concrete action
 * branches above, all of which also fix `kind` to `'action'`. Reusing private
 * field-shape bundles between these branches and trace branches avoids field
 * drift, while keeping each wrapper strict and action-specific. This nested
 * union is specifically chosen over optional fields or `.superRefine()` so
 * zod and the derived JSON Schema both require the same branch fields.
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
 * This strict branch fixes `kind: 'assert'` and `check: 'text-visible'`
 * and carries `id` plus `text: InterpolatableText`. It has no target because
 * the check's vocabulary is text visibility rather than an element locator.
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
 * This strict branch fixes `kind: 'assert'` and `check:
 * 'element-visible'`, then requires `id` and `target: ElementRef`.
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
 * This strict branch fixes the `text-equals` check discriminant and
 * requires `id`, `target`, and `text: InterpolatableText`. Its text remains
 * non-secret by construction, just as other displayable assertion content.
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
 * This strict branch fixes `check: 'url-matches'` and requires `id`
 * with `pattern: InterpolatableText`. The field is deliberately text, not a
 * zod URL type, because it represents a matching expression and retains the
 * common prohibition on embedded secret tokens.
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
 * This strict branch fixes `check: 'element-count'` and requires
 * `id`, `target`, and a `count` that is a non-negative integer. Zero is a
 * valid and useful expected count; negative numbers and fractional values are
 * rejected because they cannot describe a DOM element count.
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
 * This schema discriminates on the flat `check` field across the five
 * concrete branches. Each fixes `kind` to `'assert'`, so `Step` first selects
 * the outer kind and this schema then selects the check-specific required
 * fields. Keeping `check` flat avoids an awkward `step.check.check` nesting
 * and makes the generated nested `oneOf` exactly describe the valid shapes.
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
 * Its strict object fixes `kind: 'capture'` and requires `id`, a
 * `target: ElementRef`, and `variable: RunVariableName`. Capture produces a
 * bare variable identifier; a later interpolation feature is responsible for
 * consuming it through the distinct `{{run.*}}` syntax.
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
 * This strict object fixes `kind: 'ai'`, requires `id` and
 * `instruction: InterpolatableText`, and permits `trace: Trace` only when a
 * trace was recorded. The optional trace keeps the compiled plan representable
 * before grounding exists while ensuring any persisted trace follows the same
 * action and secret-reference rules as executable actions.
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
 * Validates one ordered instruction in a compiled plan.
 *
 * This schema is a discriminated union on `kind` over {@link ActionStep},
 * {@link AssertStep}, {@link CaptureStep}, and {@link AiStep}. The action and
 * assertion members are nested discriminated unions in their own right. This
 * fully enumerates every branch and lets JSON Schema express the same
 * action- and check-specific required fields instead of relying on refinements
 * that only zod could execute.
 */
export const Step = z.discriminatedUnion('kind', [ActionStep, AssertStep, CaptureStep, AiStep]);

/**
 * The parsed outer step union narrowed by its `kind` discriminant.
 */
export type Step = z.infer<typeof Step>;

/**
 * Validates a recorded `click` trace action.
 *
 * It reuses the executable click action's `target` field semantics but is a
 * separate strict object `{ type: 'click', target }`: trace records use
 * `type`, whereas plan steps use both `kind` and `action`.
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
 * Its strict shape fixes `type: 'navigate'` and carries the shared
 * `url: InterpolatableText` field, so recorded navigation cannot embed a
 * secret reference either.
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
 * This strict shape fixes `type: 'press'` and reuses the same target and
 * five-value key enum as {@link PressAction}, preventing replay recordings
 * from expanding the execution vocabulary silently.
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
 * This strict shape fixes `type: 'fill'` and reuses `target` and
 * `value: InterpolatableText` from the live fill action. A trace is committed
 * grounding data, so it receives the same secret-token exclusion as a plan.
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
 * This strict shape fixes `type: 'fill-secret'` and requires `target`
 * plus `secretRef: SecretRef`, exactly as {@link FillSecretAction} does. This
 * separate branch is non-negotiable because grounding traces are committed:
 * recording a password keystroke must preserve a reference, never its literal
 * value.
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
 * This schema is a discriminated union on `type` over the five trace
 * action branches. Its private shared field bundles intentionally mirror
 * action-step bundles; the wrapper differs only because a trace records an
 * action verb rather than carrying a plan step's `id` and outer `kind`.
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
 * This schema is simply `z.array(TraceAction)`. An empty
 * array is structurally valid—even though it is not useful grounding—because
 * recording zero actions is not a malformed JSON document and policy about
 * usefulness belongs outside this trust-boundary schema.
 */
export const Trace = z.array(TraceAction);

/**
 * The parsed ordered list of {@link TraceAction} values.
 */
export type Trace = z.infer<typeof Trace>;

/**
 * Represents every value that can exist in RFC 8259 JSON and therefore in a
 * serializable compiler-metadata record.
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
 * Validates {@link JsonValueT} recursively for `compilerMeta` values.
 *
 * The `z.lazy()` initializer has an explicit `z.ZodType<JsonValueT>`
 * annotation. Strict TypeScript can otherwise recurse through the
 * self-referential initializer and report a circular implicit-`any`; the
 * annotation fixes the recursive boundary while
 * the lazy union validates strings, numbers, booleans, null, arrays, and
 * records. It must not use `z.unknown()`: metadata is non-canonical for plan
 * hashing, but it still lives in a committed JSON artifact and must be
 * representable as JSON.
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
 * Validates the complete compiled plan document that is reviewed and
 * committed beside its source test prompt.
 *
 * This strict object has `schemaVersion: 1`; `source` as a strict object
 * with `inputsDigest: {@link HexSha256}`; optional `compilerMeta:
 * Record<string, JsonValue>`; named `targets` records whose values are
 * {@link TargetDefinition}; and ordered `steps` of {@link Step}.
 * Its sole `.superRefine()` walks `steps`, records seen IDs, and adds a custom
 * issue at each later duplicate's `['steps', index, 'id']` path. Projected
 * uniqueness cannot be represented by JSON Schema 2020-12 (`uniqueItems`
 * compares complete values), so duplicate-ID tests are deliberately zod-only
 * and excluded from the otherwise equivalent validation corpus.
 */
export const PlanDocument = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.strictObject({ inputsDigest: HexSha256 }),
  compilerMeta: z.record(z.string(), JsonValue).optional(),
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
 * The parsed compiled plan. It is the input to later canonical serialization
 * and digest computation; callers must not hand-edit an IR object to bypass
 * the document schema.
 */
export type PlanDocument = z.infer<typeof PlanDocument>;

/**
 * Validates the committed grounding cache associated with one plan digest.
 *
 * This strict object has `schemaVersion: 1`, `planDigest:
 * {@link HexSha256}`, and an `entries` record keyed by {@link StepId}. Each
 * entry is itself a strict object with required {@link Fingerprint} and
 * optional {@link Trace}. The record key ensures grounding belongs to
 * descriptive plan steps instead of fragile positions, and the plan digest
 * makes stale grounding detectable by the later pure provenance helper.
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
 * for a particular compiled plan.
 */
export type GroundingDocument = z.infer<typeof GroundingDocument>;
