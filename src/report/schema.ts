import { z } from 'zod';

/**
 * Defines the versioned structured-report contract that eventual CLI JSON and
 * MCP structured responses will share. Each boundary will reject unknown
 * fields so machine consumers receive a deliberate, stable shape rather than
 * permissive diagnostic objects.
 */

/**
 * Zod schema for the stable, machine-readable vocabulary of tool errors in a
 * structured report.
 *
 * The eventual enum will remain independent from internal error classes so the
 * external contract can evolve without exposing implementation names.
 */
export const ReportErrorCode = z.never();

/**
 * A stable machine-readable code for an error serialized in a report.
 */
export type ReportErrorCode = z.infer<typeof ReportErrorCode>;

/**
 * Zod schema for a tool error attached to a command or an individual test
 * case.
 *
 * @remarks
 * The eventual schema will use a flat four-branch `z.union`, one for each
 * scope-and-kind combination, to make code, kind, and scope correlations
 * structural. A `z.discriminatedUnion` cannot serve here because Zod rejects
 * repeated discriminator values and `scope` has only two distinct values
 * across the four branches.
 */
export const ReportError = z.never();

/**
 * An error entry emitted in a structured report.
 */
export type ReportError = z.infer<typeof ReportError>;

/**
 * Zod schema for command-level outcome counts.
 *
 * The eventual counts will be non-negative integers, but the schema will not
 * require a total to equal the other buckets: command-specific status
 * vocabularies do not define one universal accounting formula.
 */
export const Summary = z.never();

/**
 * Aggregated outcome counts for one command report.
 */
export type Summary = z.infer<typeof Summary>;

/**
 * Zod schema for the result of an executed test step.
 *
 * The eventual `type` identifies the step's behavioral category, whereas
 * `kind` identifies the category of diagnostic information; they are separate
 * axes and must never be conflated.
 *
 * @remarks
 * Diagnostic fields such as kind, expected and actual values, screenshots,
 * and observed data will remain optional rather than status-keyed. The design
 * contract illustrates only a failed step, so a stricter union would invent
 * unstated requirements for passed or skipped steps.
 */
export const StepResult = z.never();

/**
 * The structured outcome of one test step.
 */
export type StepResult = z.infer<typeof StepResult>;

/**
 * Zod schema for the accessibility evidence attached to an observed
 * diagnostic.
 *
 * @remarks
 * The eventual `note` will be a fixed `z.literal`, not caller- or
 * AI-generated free text. That exact disclaimer is part of the
 * prompt-injection isolation contract, so a missing or altered value must be
 * rejected rather than silently accepted.
 */
export const Observed = z.never();

/**
 * Accessibility evidence retained with an observed step diagnostic.
 */
export type Observed = z.infer<typeof Observed>;

/**
 * Zod schema for one result produced by the `run` command.
 *
 * The eventual shape combines case identity, source and plan locations,
 * duration, step outcomes, and an explanatory diagnostic so a partial run can
 * be reported without losing the context of each case.
 */
export const RunResult = z.never();

/**
 * A per-case result emitted by a `run` report.
 */
export type RunResult = z.infer<typeof RunResult>;

/**
 * Zod schema for one result produced by the `heal` command.
 *
 * It will share the run result's diagnostic bundle while keeping a
 * healing-specific status vocabulary, allowing consumers to distinguish a
 * repair outcome from an ordinary execution outcome.
 */
export const HealResult = z.never();

/**
 * A per-case result emitted by a `heal` report.
 */
export type HealResult = z.infer<typeof HealResult>;

/**
 * Zod schema for one result produced by the `generate` command.
 *
 * This variant gives plan generation its own result vocabulary instead of
 * overloading execution-oriented step results.
 */
export const GenerateResult = z.never();

/**
 * A result item emitted by a `generate` report.
 */
export type GenerateResult = z.infer<typeof GenerateResult>;

/**
 * Zod schema for one result produced by the `check` command.
 *
 * A dedicated variant keeps validation outcomes machine-readable without
 * implying that every command operates on executable steps.
 */
export const CheckResult = z.never();

/**
 * A result item emitted by a `check` report.
 */
export type CheckResult = z.infer<typeof CheckResult>;

/**
 * Zod schema for one result produced by the `review` command.
 *
 * The command is planned for a later CLI generation, but its result shape is
 * part of the fixed report contract now so consumers will not need a parallel
 * envelope design when that command arrives.
 */
export const ReviewResult = z.never();

/**
 * A result item emitted by a `review` report.
 */
export type ReviewResult = z.infer<typeof ReviewResult>;

/**
 * Zod schema for the complete versioned output of a reporting command.
 *
 * @remarks
 * The eventual envelope will discriminate on `command` and pair each command
 * with its own result array shape. It includes `review` because that shape is
 * already fixed by the contract, while excluding `init` because initialization
 * has no structured output. Its timestamp will use the repository's portable
 * UTC-`Z` ISO-8601 pattern instead of a second date-validation convention.
 */
export const ReportEnvelope = z.never();

/**
 * The versioned structured report emitted by a reporting command.
 */
export type ReportEnvelope = z.infer<typeof ReportEnvelope>;
