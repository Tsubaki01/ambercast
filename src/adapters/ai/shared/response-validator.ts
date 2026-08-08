/**
 * Defines adapter-boundary validation for raw provider text before it can
 * cross the AI port as typed data.
 */

import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';

import type { TypedJsonSchema } from '#core/ai/typed-json-schema.js';
import { AiResponseInvalidError } from '#core/errors/ai-response-invalid-error.js';

/**
 * One readable location and explanation for a provider-response violation.
 */
export interface AiResponseValidationIssue {
  /**
   * JSON Pointer-like location: invalid JSON uses `''`, while an AJV
   * root-level schema violation uses `/`.
   */
  readonly path: string;

  /** Parser or JSON Schema diagnostic that explains the violation. */
  readonly message: string;
}

/**
 * Parses and validates a provider response against its requested schema.
 *
 * @typeParam T - The response shape associated with `schema` at this call.
 * @param raw - The unparsed text returned by the provider protocol.
 * @param schema - The JSON Schema that defines the accepted response.
 * @returns The parsed value after schema validation.
 * @throws {import('#core/errors/ai-response-invalid-error.js').AiResponseInvalidError}
 * When JSON parsing or schema validation fails.
 * @remarks
 * Validation uses an `Ajv2020` instance configured with
 * `allErrors: true`. Invalid JSON becomes one issue with `path: ''` because
 * AJV has no instance path to inspect. Schema failures become one issue per AJV
 * error. A `required` violation appends its missing property to AJV's
 * `instancePath`; all other violations render an empty `instancePath` as `/`
 * for a readable root-level location. Both paths retain raw text for callers
 * while classifying the failure identically.
 */
export function validateAiResponse<T>(raw: string, schema: TypedJsonSchema<T>): T {
  let value: unknown;

  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new AiResponseInvalidError(
      'The AI provider returned malformed JSON.',
      { raw, issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }] },
      { cause: error },
    );
  }

  const validator = new Ajv2020({ allErrors: true }).compile(schema);
  if (validator(value)) {
    return value as T;
  }

  const issues: readonly AiResponseValidationIssue[] = (validator.errors ?? []).map((error: ErrorObject) => ({
    path: error.keyword === 'required'
      ? `${error.instancePath}/${String(error.params.missingProperty)}`
      : error.instancePath === '' ? '/' : error.instancePath,
    message: error.message ?? 'JSON Schema validation failed.',
  }));

  throw new AiResponseInvalidError('The AI provider response did not satisfy its schema.', { raw, issues });
}
