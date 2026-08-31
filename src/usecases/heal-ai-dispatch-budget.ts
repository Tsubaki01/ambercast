import type { InstructionCoveredAiExecutor } from '#ports/ai.js';
import type { Clock, EventSink, RunEvent } from '#ports/system.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { isRepairableNavigationFailure } from '#usecases/run.js';

const DISPATCH_DENIED: unique symbol = Symbol('dispatch-denied');

class DispatchDeniedError extends Error {
  readonly [DISPATCH_DENIED] = true;

  constructor(readonly reason: DispatchBudgetDenialReason) {
    super('The AI dispatch budget denied this phase.');
  }
}

const DISPATCH_PROTOCOL_VIOLATION: unique symbol = Symbol('dispatch-protocol-violation');

/**
 * Marks a broken event-to-dispatch contract inside the budget controller.
 *
 * Unlike `DispatchDeniedError`, which represents an ordinary admission
 * decision that `runPhase` settles, this sentinel identifies a programming
 * error that must reject the phase call. `duplicate-pending-ai-call` means a
 * caller promised a second dispatch before the first promise was consumed.
 * `missing-pending-ai-call` means a dispatch arrived without its required
 * caller-owned event. `unconsumed-pending-ai-call` means an admitted phase
 * closed with a promised dispatch that never occurred. `stale-events-proxy`
 * means a phase-bound proxy was retained and used after its phase stopped
 * being the open phase.
 */
class DispatchProtocolError extends Error {
  readonly [DISPATCH_PROTOCOL_VIOLATION] = true;

  constructor(readonly reason:
    | 'duplicate-pending-ai-call'
    | 'missing-pending-ai-call'
    | 'unconsumed-pending-ai-call'
    | 'stale-events-proxy') {
    super(`AI dispatch budget protocol violation: ${reason}.`);
  }
}

/**
 * Holds the state that must be fresh for each phase yet remain reachable from
 * the controller-scoped memoized executor through `openPhase`; controller
 * fields would share it across phases, while bare `runPhase` locals would be
 * unreachable from that executor.
 */
type OpenPhase = {
  kind: DispatchBudgetPhaseKind;
  deniedReason?: DispatchBudgetDenialReason;
  pendingAiCall?: Extract<RunEvent, { type: 'ai-call' }> | undefined;
  deferredRejection?: Extract<RunEvent, { type: 'heal-stage2-rejected' }>;
};

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
 * `runPhase` can reject with `DispatchProtocolError` when callers break the
 * event-to-dispatch protocol; this union instead captures ordinary completion
 * or failure from `work` after the phase settles. The `admitted` field is the
 * only authority a caller may use to decide whether to keep or discard
 * `work`'s result and any caller-owned effects gated on it; it does not govern
 * events the controller already admitted and published to the real sink. Never
 * use `instanceof`, error-message matching, or any inspection of what
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
   * @throws {DispatchProtocolError} If an `ai-call` is duplicated, omitted
   * before a dispatch, left unconsumed at an admitted phase boundary, or sent
   * through a proxy after that proxy's phase has settled.
   * @example
   * ```ts
   * // `overlay` holds speculative changes that a denied phase must discard.
   * const snapshot = overlay.snapshot();
   * const outcome = await budget.runPhase('incremental', async (phaseDeps) => {
   *   // Provider resolution may take arbitrarily long, so complete it first.
   *   const executor = await phaseDeps.resolveAiExecutor();
   *   // No await may separate this event from the dispatch it names.
   *   phaseDeps.events.emit({ type: 'ai-call', stepId: 'repair-step' });
   *   return executor.execute(request);
   * });
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

  /**
   * A phase-bound proxy, not the real case event sink. Phase work must emit
   * through this proxy so the budget can hold an `ai-call` until its named
   * dispatch is admitted and defer `heal-stage2-rejected` until the phase
   * settles, when it becomes visible only for an admitted phase; every other
   * event passes through to the real sink unchanged. The proxy rejects a
   * duplicate `ai-call` before the decorated executor consumes it and rejects
   * reuse after settlement.
   */
  readonly events: EventSink;
}

/**
 * Creates the admission controller and lazy, case-scoped executor decorator.
 *
 * @remarks
 * This module defines the module-private, `unique symbol`-branded
 * `DispatchDeniedError`. The decorated `execute` and `executeAgentic` methods
 * throw `DispatchDeniedError` when either phase kind is denied, including
 * Stage 3's deadline-only denial. `runPhase` catches and consumes it
 * internally to produce the phase's final `deniedReason`; it never escapes
 * `runPhase` to any caller. It is a defense-in-depth leak detector, not a
 * report error, and callers such as `heal.ts` must never inspect it.
 *
 * The phase-local event proxy keeps each caller-owned `ai-call` pending until
 * its dispatch is admitted, defers `heal-stage2-rejected` until the phase
 * settles, and passes every other `RunEvent` straight to the real sink. It
 * retains those slots on the per-phase record and checks that record's
 * identity against `openPhase`, so a proxy retained beyond settlement cannot
 * affect a later phase. A denied phase discards its deferred rejection event.
 * For an otherwise admitted phase, the controller first checks for an
 * unconsumed pending `ai-call` and throws `unconsumed-pending-ai-call`; only
 * when no protocol violation exists does it flush one deferred
 * `heal-stage2-rejected` event. This ordering prevents an invalid phase from
 * publishing a rejection event to the real sink.
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
 * @param params.events - The real event sink behind each phase-local proxy.
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
 *   events: deps.events,
 *   deadlineMs: deadline,
 *   maxDispatches: caseDeps.config.heal.maxStepRepairs ?? Infinity,
 * });
 * ```
 */
export function createHealAiDispatchBudget(params: {
  readonly resolveAiExecutor: (signal?: AbortSignal) => Promise<InstructionCoveredAiExecutor>;
  readonly signal: AbortSignal | undefined;
  readonly clock: Pick<Clock, 'monotonicMs'>;
  readonly events: EventSink;
  readonly deadlineMs: number;
  readonly maxDispatches: number;
}): HealAiDispatchBudget {
  if (params.maxDispatches !== Infinity && (!Number.isFinite(params.maxDispatches) || !Number.isInteger(params.maxDispatches) || params.maxDispatches <= 0)) {
    throw new Error('maxDispatches must be Infinity or a finite positive integer.');
  }

  let openPhase: OpenPhase | undefined;
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

  /**
   * Binds one caller-owned `ai-call` to one executor attempt. Clearing the
   * pending slot before admission keeps a denied dispatch's event out of the
   * real sink, while a dispatch without its caller-owned event remains a
   * programming error.
   */
  const dispatch = async <T>(phase: OpenPhase | undefined, perform: () => Promise<T>): Promise<T> => {
    if (phase === undefined) throw new Error('AI dispatch attempted outside an open budget phase.');
    const event = phase.pendingAiCall;
    if (event === undefined) throw new DispatchProtocolError('missing-pending-ai-call');
    phase.pendingAiCall = undefined;
    admitDispatch();
    params.events.emit(event);
    return perform();
  };

  const resolveAiExecutor = async (): Promise<InstructionCoveredAiExecutor> => {
    if (decoratedExecutor !== undefined) return decoratedExecutor;
    const executor = await params.resolveAiExecutor(params.signal);
    decoratedExecutor = {
      name: executor.name,
      isAvailable: (signal) => executor.isAvailable(signal),
      execute: async (request) => {
        return dispatch(openPhase, () => executor.execute(request));
      },
      executeAgentic: async (request) => {
        return dispatch(openPhase, () => executor.executeAgentic(request));
      },
    };
    return decoratedExecutor;
  };

  return {
    async runPhase<T>(kind: DispatchBudgetPhaseKind, work: (deps: HealAiDispatchPhaseDeps) => Promise<T>): Promise<DispatchBudgetPhaseOutcome<T>> {
      if (openPhase !== undefined) throw new Error('A dispatch-budget phase is already open.');
      if (params.clock.monotonicMs() >= params.deadlineMs) return { admitted: false, deniedReason: 'deadline' };

      const phase: OpenPhase = { kind };
      openPhase = phase;
      let result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
      try {
        result = {
          ok: true,
          value: await work({
            resolveAiExecutor,
            events: {
              emit(event): void {
                if (openPhase !== phase) throw new DispatchProtocolError('stale-events-proxy');
                if (event.type === 'ai-call') {
                  if (phase.pendingAiCall !== undefined) throw new DispatchProtocolError('duplicate-pending-ai-call');
                  phase.pendingAiCall = event;
                  return;
                }
                if (event.type === 'heal-stage2-rejected') {
                  phase.deferredRejection = event;
                  return;
                }
                params.events.emit(event);
              },
            },
          }),
        };
      } catch (error) {
        if (error instanceof DispatchProtocolError) throw error;
        result = { ok: false, error };
      } finally {
        openPhase = undefined;
      }
      if (phase.deniedReason !== undefined && !(result.ok === false
        && result.error instanceof IntegrityViolationError
        && !isRepairableNavigationFailure(result.error))) {
        return { admitted: false, deniedReason: phase.deniedReason };
      }
      if (phase.pendingAiCall !== undefined) throw new DispatchProtocolError('unconsumed-pending-ai-call');
      if (phase.deferredRejection !== undefined) params.events.emit(phase.deferredRejection);
      return { admitted: true, result };
    },
  };
}
