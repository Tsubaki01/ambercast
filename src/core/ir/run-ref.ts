import type { Step } from './schema.js';

/**
 * One run-reference token found in a text-bearing plan field.
 *
 * `raw` always preserves the source token, including malformed syntax, so
 * validation and obligation comparison cannot silently discard a reference.
 * `name` is present only for a recognized token; `malformed` lets consumers
 * retain the original spelling while applying their own failure policy.
 */
export interface RunReferenceToken {
  readonly raw: string;
  readonly name: string | undefined;
  readonly malformed: boolean;
}

/**
 * Finds run-reference tokens using the grammar shared by IR and replay validation.
 *
 * @param value - One text-bearing step field to scan.
 * @returns Tokens in source order, including malformed tokens as raw values.
 * @remarks
 * A single pure matcher prevents core obligation fingerprints and usecase
 * validation from drifting into incompatible interpretations. It recognizes
 * rather than rejects malformed syntax because callers need to preserve it as
 * an obligation or classify it at their own validation boundary.
 */
export function matchRunReferenceTokens(value: string): readonly RunReferenceToken[] {
  const tokens: RunReferenceToken[] = [];
  const pattern = /\{\{run\.(?:[\s\S]*?\}\}|[\s\S]*$)/g;
  for (const match of value.matchAll(pattern)) {
    const raw = match[0]!;
    const closed = raw.endsWith('}}');
    const name = closed ? raw.slice('{{run.'.length, -'}}'.length) : raw.slice('{{run.'.length);
    const valid = closed && /^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/.test(name);
    tokens.push({ raw, name: valid ? name : undefined, malformed: !valid });
  }
  return tokens;
}

/**
 * Extracts every run reference used by the text-bearing fields of a step.
 *
 * @param step - The plan step whose supported text fields are inspected.
 * @returns Raw reference tokens in encounter order, without deduplication.
 * @remarks
 * The extractor covers navigation URLs, fill values, text assertion
 * values, URL-match patterns, and AI instructions. Order and repetition are
 * obligations: a candidate that uses an output twice, or in a different
 * citation sequence, is not interchangeable with one that uses it once.
 * Malformed tokens remain in the result so they cannot be laundered away.
 */
export function extractStepRunRefs(step: Step): readonly string[] {
  const fields: string[] = [];
  if (step.kind === 'action' && (step.action === 'navigate' || step.action === 'fill')) fields.push(step.action === 'navigate' ? step.url : step.value);
  if (step.kind === 'assert' && (step.check === 'text-visible' || step.check === 'text-equals')) fields.push(step.text);
  if (step.kind === 'assert' && step.check === 'url-matches') fields.push(step.pattern);
  if (step.kind === 'ai') fields.push(step.instruction);
  return fields.flatMap((field) => matchRunReferenceTokens(field).map(({ raw }) => raw));
}
