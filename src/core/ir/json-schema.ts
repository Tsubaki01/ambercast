/**
 * Converts the zod-owned IR document definitions into public JSON Schema.
 *
 * This core module is pure: it returns converted values without filesystem
 * access, path selection, text serialization, or global mutation. Keeping
 * conversion here prevents the build tool and AJV-equivalence tests from
 * acquiring divergent handwritten schema definitions.
 *
 * Zod's default conversion targets JSON Schema 2020-12. Structural
 * constraints survive the conversion; {@link PlanDocument}'s projected
 * duplicate step-ID check remains the intentional zod-only exception.
 */
import { z } from 'zod';
import { GroundingDocument, PlanDocument } from './schema.js';

/**
 * Returns a newly derived JSON Schema 2020-12 document for the complete plan
 * artifact.
 *
 * Each call returns a pure, unmodified value suitable for independent AJV
 * compilation; the build tool alone owns file serialization. Cross-step ID
 * uniqueness remains zod-only because JSON Schema cannot express it.
 */
export function getPlanJsonSchema(): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(PlanDocument);
}

/**
 * Returns a newly derived JSON Schema 2020-12 document for the grounding
 * cache artifact.
 *
 * Like {@link getPlanJsonSchema}, this filesystem-free, deterministic getter
 * gives strict-AJV tests and the build tool the same derived value.
 */
export function getGroundingJsonSchema(): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(GroundingDocument);
}
