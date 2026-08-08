/**
 * Couples a JSON Schema's static response type to the call that transports it
 * across the AI port.
 *
 * The brand has no runtime representation and therefore cannot validate a
 * deserialized value or survive a subprocess boundary. It only prevents a
 * caller in this process from pairing `execute<T>` with a schema derived for
 * an unrelated `T`; runtime validation remains the adapter's responsibility.
 */
import { z } from 'zod';

declare const typedJsonSchemaBrand: unique symbol;

/**
 * A JSON Schema branded with the TypeScript value shape it validates.
 *
 * @typeParam T - The response type associated with this schema at its local
 * construction site.
 * @remarks
 * The required phantom property intentionally makes mismatched generic calls
 * fail at compile time. It is a type-level association, not a claim that a
 * remote provider value has already been checked.
 */
export type TypedJsonSchema<T> = Record<string, unknown> & {
  readonly [typedJsonSchemaBrand]: T;
};

/**
 * Derives a transportable JSON Schema while retaining the source Zod type for
 * the local AI-port call.
 *
 * @typeParam S - The Zod schema whose inferred type brands the result.
 * @param schema - The Zod schema to convert to JSON Schema.
 * @returns A JSON Schema whose compile-time brand is `z.infer<S>`.
 * @remarks
 * The conversion derives the payload with `z.toJSONSchema` and uses a
 * deliberate `unknown` double-cast because Zod's runtime JSON value cannot
 * express the compile-time-only required unique-symbol property.
 */
export function typedJsonSchema<S extends z.ZodType>(schema: S): TypedJsonSchema<z.infer<S>> {
  return z.toJSONSchema(schema) as unknown as TypedJsonSchema<z.infer<S>>;
}
