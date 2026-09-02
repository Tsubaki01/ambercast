import type { InstructionCoveredAiExecutor } from '#ports/ai.js';
import type { Clock, EventSink, RunEvent } from '#ports/system.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';

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
  /**
   * Retains this token's first protocol violation. The token is set once and
   * never overwritten so settle-time arbitration can reject the earliest
   * broken contract ahead of every other outcome for the phase.
   */
  protocolViolation?: DispatchProtocolError;
};

/**
 * Creates the error for one broken protocol event and preserves the first
 * instance on the phase token. Callers throw the returned value directly;
 * they do not need a separate catch-and-store path because settle-time code
 * reads the latch itself. A later call still receives a fresh error that
 * reports its own synchronous reason, while the existing token remains the
 * phase's authoritative first violation.
 */
const recordProtocolViolation = (phase: OpenPhase, reason: DispatchProtocolError['reason']): DispatchProtocolError => {
  const error = new DispatchProtocolError(reason);
  phase.protocolViolation ??= error;
  return error;
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
 * event-to-dispatch protocol; this union instead captures a completed phase,
 * a denial, or a thrown integrity failure after the phase settles. `status` is
 * the only authority a caller may use to decide whether to keep or discard
 * `work`'s result and caller-owned effects gated on it; it does not govern
 * events the controller already admitted and published to the real sink. Never
 * use `instanceof`, error-message matching, or any inspection of what `work`
 * threw or returned for that decision. A denied outcome deliberately hides the
 * captured result so report-facing callers cannot accidentally retain partial
 * phase output. An `integrity-failure` outcome exposes every thrown
 * `IntegrityViolationError`, including subclasses, so callers rethrow it
 * without overriding this controller's arbitration.
 */
export type DispatchBudgetPhaseOutcome<T> =
  | { readonly status: 'completed'; readonly result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } }
  | { readonly status: 'denied'; readonly deniedReason: DispatchBudgetDenialReason }
  | { readonly status: 'integrity-failure'; readonly error: IntegrityViolationError };

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
   * value and any ordinary error it threw. Every `IntegrityViolationError`
   * thrown by `work`, exact class or subclass, instead produces an
   * `integrity-failure` outcome regardless of the denial state. Embedded
   * integrity failures remain caller-specific values, so callers convert them
   * to thrown errors before `work` settles when they require this arbitration.
   * The controller inspects only a failed result's error, never a successful
   * result's value.
   *
   * After `work` settles, the controller gives its own first-latched protocol
   * violation priority, then turns an unconsumed `ai-call` into and latches a
   * fresh protocol violation. It next returns a thrown
   * `IntegrityViolationError`, then a latched denial, and otherwise completes
   * the phase. This order keeps phase-local protocol integrity ahead of
   * integrity and denial arbitration even when an intermediate caller catches
   * the original error. Deferred Stage 2 rejection events are never flushed
   * on any of the first four outcomes.
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
   * @returns The only keep-or-discard authority for the settled phase. A
   * `completed` outcome preserves `work`'s success or ordinary failure, a
   * `denied` outcome contains the controlling reason, and an
   * `integrity-failure` outcome contains the thrown integrity error.
   * @throws {Error} If another phase from this controller is already open.
   * @throws {DispatchProtocolError} If an `ai-call` is duplicated, omitted
   * before a dispatch, left unconsumed at a phase boundary, or sent
   * through a proxy after that proxy's phase has settled.
   * @example
   * ```ts
   * const assertNever = (value: never): never => {
   *   throw new Error(`Unreachable dispatch-budget phase status: ${String(value)}`);
   * };
   *
   * repairLoop: while (needsRepair()) {
   *   // `overlay` holds speculative changes that a denied phase must discard.
   *   const snapshot = overlay.snapshot();
   *   const outcome = await budget.runPhase('incremental', async (phaseDeps) => {
   *     // Provider resolution may take arbitrarily long, so complete it first.
   *     const executor = await phaseDeps.resolveAiExecutor();
   *     // No await may separate this event from the dispatch it names.
   *     phaseDeps.events.emit({ type: 'ai-call', stepId: 'repair-step' });
   *     return executor.execute(request);
   *   });
   *
   *   switch (outcome.status) {
   *     case 'denied': {
   *       overlay.restore(snapshot);
   *       stopReason = outcome.deniedReason;
   *       break repairLoop;
   *     }
   *     case 'integrity-failure': {
   *       overlay.restore(snapshot);
   *       throw outcome.error;
   *     }
   *     case 'completed': {
   *       if (!outcome.result.ok) throw outcome.result.error;
   *       measurement = outcome.result.value;
   *       break;
   *     }
   *     default: {
   *       assertNever(outcome);
   *     }
   *   }
   *
   *   // Existing loop control remains outside the switch.
   *   if (shouldRetry(measurement)) continue;
   * }
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
   * settles. The deferred rejection becomes visible only when the phase has
   * `completed` status and a successful result; every other event passes
   * through to the real sink unchanged. The proxy rejects a duplicate
   * `ai-call` before the decorated executor consumes it and rejects reuse
   * after settlement.
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
 * affect a later phase. After work settles, its own first-latched protocol
 * violation rejects first; an unconsumed pending `ai-call` becomes and
 * latches a fresh protocol violation next; a thrown
 * `IntegrityViolationError` follows; a latched denial follows that; and all
 * remaining work completes. Protocol integrity must win over integrity and
 * denial arbitration, so deferred Stage 2 rejection events are never flushed
 * on any of those first four outcomes. Only a successful completed phase
 * flushes one deferred `heal-stage2-rejected` event, preventing invalid or
 * unsuccessful work from publishing it to the real sink.
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
   * real sink, while a dispatch without its caller-owned event latches its
   * protocol violation before throwing so settle-time code cannot lose it.
   */
  const dispatch = async <T>(phase: OpenPhase | undefined, perform: () => Promise<T>): Promise<T> => {
    if (phase === undefined) throw new Error('AI dispatch attempted outside an open budget phase.');
    const event = phase.pendingAiCall;
    // Latching this missing caller-owned event before throwing preserves it
    // for settle-time arbitration even when an intermediate caller catches it.
    if (event === undefined) throw recordProtocolViolation(phase, 'missing-pending-ai-call');
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
      if (params.clock.monotonicMs() >= params.deadlineMs) return { status: 'denied', deniedReason: 'deadline' };

      const phase: OpenPhase = { kind };
      openPhase = phase;
      let result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
      try {
        result = {
          ok: true,
          value: await work({
            resolveAiExecutor,
            events: {
              /**
               * Keeps event ownership on this captured phase. A stale proxy,
               * duplicate pending `ai-call`, or any other phase-local protocol
               * breach latches on this token before throwing, so it cannot be
               * downgraded by an intermediate catch or contaminate a later phase.
              */
              emit(event): void {
                // A retained proxy latches on its captured token before throwing,
                // leaving later phases untouched.
                if (openPhase !== phase) throw recordProtocolViolation(phase, 'stale-events-proxy');
                if (event.type === 'ai-call') {
                  // A second promise latches before throwing, preserving the first
                  // failure for this phase's settle sequence.
                  if (phase.pendingAiCall !== undefined) throw recordProtocolViolation(phase, 'duplicate-pending-ai-call');
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
        result = { ok: false, error };
      } finally {
        openPhase = undefined;
      }
      // Settle checks preserve this phase's captured protocol violation before
      // integrity or denial arbitration, and latch an unconsumed pending call too.
      if (phase.protocolViolation !== undefined) throw phase.protocolViolation;
      if (phase.pendingAiCall !== undefined) throw recordProtocolViolation(phase, 'unconsumed-pending-ai-call');
      if (result.ok === false && result.error instanceof IntegrityViolationError) {
        return { status: 'integrity-failure', error: result.error };
      }
      if (phase.deniedReason !== undefined) return { status: 'denied', deniedReason: phase.deniedReason };
      if (result.ok === true && phase.deferredRejection !== undefined) params.events.emit(phase.deferredRejection);
      return { status: 'completed', result };
    },
  };
}
