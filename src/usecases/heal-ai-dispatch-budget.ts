import type { InstructionCoveredAiExecutor } from '#ports/ai.js';
import type { Clock } from '#ports/system.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { isRepairableNavigationFailure } from '#usecases/run.js';

const DISPATCH_DENIED: unique symbol = Symbol('dispatch-denied');

class DispatchDeniedError extends Error {
  readonly [DISPATCH_DENIED] = true;

  constructor(readonly reason: DispatchBudgetDenialReason) {
    super('The AI dispatch budget denied this phase.');
  }
}

/**
 * Classifies repair phases by the admission policy they require.
 *
 * Incremental repairs share the case's finite dispatch allowance because each
 * provider call can extend the repair search. Stage 3 is intentionally the
 * only exception: it remains subject to the case deadline but is never rejected
 * for reaching the dispatch limit.
 */
export type DispatchBudgetPhaseKind = 'incremental' | 'stage3';

/**
 * Explains why the controller declined a phase or latched one as denied.
 *
 * Admission is evaluated in this fixed order: deadline first, then the
 * incremental dispatch limit. The ordering makes an expired case report the
 * deadline even when its allowance has also been exhausted.
 */
export type DispatchBudgetDenialReason = 'attempt-limit' | 'deadline';

/**
 * The settled outcome of one dispatch-budget phase.
 *
 * This value never throws: it captures either completion or failure from
 * `work` after the phase settles. The `admitted` field is the only authority a
 * caller may use to decide whether to keep or discard a phase's effects;
 * never use `instanceof`, error-message matching, or any inspection of what
 * `work` threw or returned for that decision. A denial deliberately hides the
 * captured result so report-facing callers cannot accidentally retain partial
 * phase output. The integrity-precedence check is this controller's
 * internal admission decision, not permission for callers to override an
 * outcome after inspecting its result.
 */
export type DispatchBudgetPhaseOutcome<T> =
  | { readonly admitted: true; readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } }
  | { readonly admitted: false; readonly deniedReason: DispatchBudgetDenialReason };

/**
 * Controls the case-scoped admission boundary around AI-backed repair work.
 */
export interface HealAiDispatchBudget {
  /**
   * Runs one repair phase and returns its settled admission outcome.
   *
   * The controller checks the deadline before invoking `work`; a
   * denied phase therefore cannot trigger lazy executor resolution. While an
   * admitted phase is open, every attempted real `execute` or
   * `executeAgentic` call first re-checks the deadline. A dispatch attempted
   * after that deadline denies the phase even when the phase started before
   * it, which is why the deadline is checked both at phase start and per
   * dispatch. Only while the deadline still permits it does an `incremental`
   * phase check its remaining dispatch allowance and charge one unit. A
   * `stage3` phase skips that allowance check entirely: it is deadline-gated
   * only and is never denied for reaching the dispatch limit. One denied
   * dispatch latches the entire phase as denied, discarding both `work`'s
   * value and any error it threw, except for a settled
   * non-repairable `IntegrityViolationError`: integrity correctness takes
   * precedence over denial and is returned as an admitted failed result so
   * existing callers rethrow it rather than adopt any phase output. The
   * closed repairable navigation-resolution exception remains discarded by a
   * denial like every ordinary phase failure.
   *
   * Callers must convert every embedded non-repairable integrity violation to
   * a thrown error before `work` settles. This method only inspects
   * `result.error`, never `result.value`, to decide that precedence; its
   * generic result type cannot safely inspect a successfully resolved value
   * for caller-specific state.
   *
   * A second phase from the same controller is a programming error while the
   * first remains open. The controller throws its reentrancy assertion at
   * entry, before checking the deadline or calling `work`; phases never nest,
   * so `work` must not call `runPhase` again until its own promise settles.
   *
   * @param kind - Whether this phase is limit-and-deadline-gated or
   * deadline-gated only.
   * @param work - Async repair work that must use the supplied phase resolver
   * for every path that can dispatch AI work.
   * @returns The only keep-or-discard authority for the completed phase. An
   * admitted result preserves `work`'s success or ordinary failure; a denied
   * result contains the controlling reason instead.
   * @throws {Error} If another phase from this controller is already open.
   * @example
   * ```ts
   * // `overlay` holds speculative changes that a denied phase must discard.
   * const snapshot = overlay.snapshot();
   * const outcome = await budget.runPhase('incremental', async (phaseDeps) =>
   *   measureReplay({ ...caseDeps, resolveAiExecutor: phaseDeps.resolveAiExecutor }),
   * );
   *
   * if (!outcome.admitted) {
   *   overlay.restore(snapshot);
   *   return outcome.deniedReason;
   * }
   * if (!outcome.result.ok) {
   *   throw outcome.result.error;
   * }
   * return outcome.result.value;
   * ```
   */
  runPhase<T>(
    kind: DispatchBudgetPhaseKind,
    work: (deps: HealAiDispatchPhaseDeps) => Promise<T>,
  ): Promise<DispatchBudgetPhaseOutcome<T>>;
}

/**
 * Dependencies exposed to work admitted by one dispatch-budget phase.
 *
 * `work` uses this resolver instead of `HealDeps.resolveAiExecutor` so every
 * nested dispatch path receives the metered executor: replay measurement via
 * `run()`, full-plan generation, and direct `execute` calls all traverse the
 * same decorated instance.
 */
export interface HealAiDispatchPhaseDeps {
  readonly resolveAiExecutor: (signal?: AbortSignal) => Promise<InstructionCoveredAiExecutor>;
}

/**
 * Creates the admission controller and lazy, case-scoped executor decorator.
 *
 * @remarks
 * This module defines a module-private `unique symbol`-branded `Error`
 * subclass. The decorated `execute` and `executeAgentic` methods
 * throw that sentinel when either phase kind is denied, including Stage 3's
 * deadline-only denial. `runPhase` catches and consumes it internally to
 * produce the phase's final `deniedReason`; the sentinel never escapes
 * `runPhase` to any caller. It is a defense-in-depth leak detector, not a
 * report error, and callers such as `heal.ts` must never inspect it. This
 * module also does not suppress or buffer `RunEvent`
 * emissions during a denied phase: F5b's discard boundary is report-facing
 * output (`RunCaseOutcome`, `finalReplayError`, `stage3Error`, and provider-error
 * rejection) discarded on a denied phase, and event ownership is explicitly
 * outside this module's scope.
 *
 * @param params - Case-local inputs for the controller.
 * @param params.resolveAiExecutor - The case's own unresolved, unbound lazy
 * resolver. It retains the `(signal?) => Promise<...>` shape that `run()`
 * expects, allowing the controller to avoid provider resolution unless an
 * admitted phase actually needs it.
 * @param params.signal - The case `AbortSignal`, passed unchanged to the real
 * resolver so cancellation during provider resolution or probing is retained.
 * @param params.clock - The monotonic clock used for all phase and dispatch
 * deadline checks in this case.
 * @param params.deadlineMs - The case-wide deadline computed once by the
 * caller, rather than a fresh deadline per phase.
 * @param params.maxDispatches - The incremental dispatch allowance: `Infinity`
 * when `heal.maxStepRepairs` is unset, otherwise a finite positive integer
 * validated when the controller is constructed.
 * @returns A controller whose phase resolver memoizes and decorates the real
 * executor only after admitted work requests it.
 * @example
 * ```ts
 * const budget = createHealAiDispatchBudget({
 *   resolveAiExecutor: (signal) => deps.resolveAiExecutor(signal),
 *   signal: deps.signal,
 *   clock: deps.clock,
 *   deadlineMs: deadline,
 *   maxDispatches: caseDeps.config.heal.maxStepRepairs ?? Infinity,
 * });
 * ```
 */
export function createHealAiDispatchBudget(params: {
  readonly resolveAiExecutor: (signal?: AbortSignal) => Promise<InstructionCoveredAiExecutor>;
  readonly signal: AbortSignal | undefined;
  readonly clock: Pick<Clock, 'monotonicMs'>;
  readonly deadlineMs: number;
  readonly maxDispatches: number;
}): HealAiDispatchBudget {
  if (params.maxDispatches !== Infinity && (!Number.isFinite(params.maxDispatches) || !Number.isInteger(params.maxDispatches) || params.maxDispatches <= 0)) {
    throw new Error('maxDispatches must be Infinity or a finite positive integer.');
  }

  let openPhase: { kind: DispatchBudgetPhaseKind; deniedReason?: DispatchBudgetDenialReason } | undefined;
  let dispatches = 0;
  let decoratedExecutor: InstructionCoveredAiExecutor | undefined;

  const denyDispatch = (): never => {
    const phase = openPhase;
    if (phase === undefined) throw new Error('AI dispatch attempted outside an open budget phase.');
    const reason: DispatchBudgetDenialReason = params.clock.monotonicMs() >= params.deadlineMs
      ? 'deadline'
      : 'attempt-limit';
    phase.deniedReason ??= reason;
    throw new DispatchDeniedError(phase.deniedReason);
  };

  const admitDispatch = (): void => {
    const phase = openPhase;
    if (phase === undefined) throw new Error('AI dispatch attempted outside an open budget phase.');
    if (params.clock.monotonicMs() >= params.deadlineMs) denyDispatch();
    if (phase.kind === 'incremental') {
      if (dispatches >= params.maxDispatches) denyDispatch();
      dispatches += 1;
    }
  };

  const resolveAiExecutor = async (): Promise<InstructionCoveredAiExecutor> => {
    if (decoratedExecutor !== undefined) return decoratedExecutor;
    const executor = await params.resolveAiExecutor(params.signal);
    decoratedExecutor = {
      name: executor.name,
      isAvailable: (signal) => executor.isAvailable(signal),
      execute: async (request) => {
        admitDispatch();
        return executor.execute(request);
      },
      executeAgentic: async (request) => {
        admitDispatch();
        return executor.executeAgentic(request);
      },
    };
    return decoratedExecutor;
  };

  return {
    async runPhase<T>(kind: DispatchBudgetPhaseKind, work: (deps: HealAiDispatchPhaseDeps) => Promise<T>): Promise<DispatchBudgetPhaseOutcome<T>> {
      if (openPhase !== undefined) throw new Error('A dispatch-budget phase is already open.');
      if (params.clock.monotonicMs() >= params.deadlineMs) return { admitted: false, deniedReason: 'deadline' };

      const phase: { kind: DispatchBudgetPhaseKind; deniedReason?: DispatchBudgetDenialReason } = { kind };
      openPhase = phase;
      let result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
      try {
        result = { ok: true, value: await work({ resolveAiExecutor }) };
      } catch (error) {
        result = { ok: false, error };
      } finally {
        openPhase = undefined;
      }
      if (phase.deniedReason !== undefined && !(result.ok === false
        && result.error instanceof IntegrityViolationError
        && !isRepairableNavigationFailure(result.error))) {
        return { admitted: false, deniedReason: phase.deniedReason };
      }
      return { admitted: true, result };
    },
  };
}
