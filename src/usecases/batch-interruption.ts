/**
 * Tracks whether caller cancellation intersects incomplete discovered work.
 *
 * @remarks
 * Discovery order is retained as ordered `{ workKey, identity }` pairs. A work
 * key names one scheduling unit, while its identity is the public report key;
 * distinct work keys may therefore share one identity and retain distinct
 * terminal evidence. Terminal membership is keyed only by work key. The
 * caller signal is observed synchronously: cancellation latches only when at
 * least one currently known work key is pending. Consequently an
 * already-aborted empty batch is not interrupted until work is discovered,
 * and an abort observed after the last work key becomes terminal does not
 * rewrite a completed outcome.
 *
 * A caller that receives multiple work items from one discovery response
 * registers that entire response in order before consulting `interrupted`.
 * This caller-side atomic boundary prevents cancellation from splitting one
 * completed discovery response into known and unknown work. Once latched,
 * interruption remains true even if in-flight work subsequently reaches a
 * terminal state. Callers dispose the listener from a `finally` block on both
 * normal and exceptional exits; disposal is idempotent so cleanup cannot
 * obscure the original outcome.
 */
export class BatchInterruptionTracker {
  private readonly discovered = new Map<string, string>();
  private readonly terminal = new Set<string>();
  private latched = false;
  private disposed = false;
  private readonly onAbort = (): void => this.latchIfPending();

  /**
   * Creates a tracker for an optional caller-owned cancellation signal.
   *
   * @param signal - Signal whose synchronous abort event defines the batch
   * interruption boundary.
   */
  constructor(private readonly signal?: AbortSignal) {
    signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  /** Whether cancellation was observed while known work was pending. */
  get interrupted(): boolean {
    return this.latched;
  }

  /**
   * First-seen public identities whose discovered work has not become terminal.
   *
   * The returned order follows first-seen work order and is deduplicated by
   * public identity. A terminal sibling with the same identity does not remove
   * a distinct pending work key, so the pending identity still produces one
   * deterministic identity-only skipped row.
   */
  get pendingIdentities(): readonly string[] {
    const identities = new Set<string>();
    for (const [workKey, identity] of this.discovered) {
      if (!this.terminal.has(workKey)) identities.add(identity);
    }
    return [...identities];
  }

  /**
   * Adds one scheduling unit and its public identity to the discovered batch.
   *
   * @param workKey - Occurrence-qualified key used only for scheduling and
   * terminality.
   * @param identity - Stable public case identity used by report rows.
   * @remarks
   * Re-adding the same `{ workKey, identity }` pair is idempotent. Rebinding an
   * existing work key to a different identity fails fast because it would make
   * terminality ambiguous. Adding work also observes the signal's current
   * state, closing the gap where asynchronous discovery learns work after
   * cancellation but before an event listener could classify the phase.
   */
  addDiscovered(workKey: string, identity: string): void {
    const existing = this.discovered.get(workKey);
    if (existing !== undefined) {
      if (existing !== identity) throw new Error(`Work key ${workKey} cannot be rebound to another identity.`);
      return;
    }
    this.discovered.set(workKey, identity);
    if (!this.disposed && this.signal?.aborted) this.latchIfPending();
  }

  /**
   * Marks one discovered scheduling unit as completed.
   *
   * @param workKey - Scheduling key whose inspection or execution completed.
   * @throws {Error} If the work key was never discovered or was already marked
   * terminal.
   * @remarks
   * Terminality records scheduling completion, not public-row creation. A
   * successful inspection that emits neither a result nor a case error still
   * becomes terminal and can never be reported as skipped.
   */
  markTerminal(workKey: string): void {
    if (!this.discovered.has(workKey)) throw new Error(`Unknown work key ${workKey}.`);
    if (this.terminal.has(workKey)) throw new Error(`Work key ${workKey} is already terminal.`);
    this.terminal.add(workKey);
  }

  /**
   * Detaches signal observation without changing the completed outcome.
   *
   * Repeated calls are safe, allowing unconditional cleanup in `finally`.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener('abort', this.onAbort);
  }

  private latchIfPending(): void {
    if ([...this.discovered.keys()].some((workKey) => !this.terminal.has(workKey))) this.latched = true;
  }
}
