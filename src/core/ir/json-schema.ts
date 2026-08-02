/**
 * Converts the zod-owned IR document definitions into public JSON Schema.
 *
 * This core module is deliberately pure: it imports the plan and grounding
 * schemas from `schema.ts`, calls zod's JSON Schema conversion, and returns
 * the result without reading files, choosing paths, serializing text, or
 * mutating global state. Its consumers are the build tool that publishes
 * static schema files and unit tests that compare AJV with zod. Keeping the
 * conversion here means they cannot acquire divergent handwritten schema
 * definitions.
 *
 * The eventual schemas target JSON Schema 2020-12 through zod's default
 * conversion and include `$schema` accordingly. Structural constraints are
 * intentionally represented through strict objects, literals, regexes, and
 * discriminated unions in `schema.ts` so they survive this conversion. The
 * only documented zod-only exception is PlanDocument's projected duplicate
 * step-ID check, which JSON Schema 2020-12 cannot express.
 */
import { z } from 'zod';

/**
 * Returns a newly derived JSON Schema 2020-12 document for the complete plan
 * artifact.
 *
 * The implementation phase will call `z.toJSONSchema(PlanDocument)` directly
 * on every invocation. It must not cache, mutate, pretty-print, write, or
 * hand-author the result: callers need a pure object suitable for independent
 * AJV compilation, while the build tool alone owns file serialization. The
 * conversion should retain all structural rules from `PlanDocument`,
 * including nested action/check `oneOf` branches and `additionalProperties:
 * false`; it intentionally cannot encode cross-step ID uniqueness.
 */
export function getPlanJsonSchema(): z.core.JSONSchema.BaseSchema {
  throw new Error('not implemented');
}

/**
 * Returns a newly derived JSON Schema 2020-12 document for the grounding
 * cache artifact.
 *
 * The implementation phase will call `z.toJSONSchema(GroundingDocument)` and
 * return the unmodified object. As with {@link getPlanJsonSchema}, this
 * function remains filesystem-free and deterministic so tests can compile it
 * under strict AJV and the build tool can serialize precisely the same value
 * for external consumers.
 */
export function getGroundingJsonSchema(): z.core.JSONSchema.BaseSchema {
  throw new Error('not implemented');
}
