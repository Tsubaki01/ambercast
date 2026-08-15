import { ERROR_EXIT_CODES, type ErrorExitCode } from './exit-codes.js';

/*
 * Declares the shared vocabulary and base class for failures that Ambercast can
 * classify before choosing its process outcome. Keeping classification on an
 * abstract error preserves a consistent boundary between domain failures and
 * the use cases that create their concrete variants.
 */

/**
 * A process status available to Ambercast.
 *
 * Zero represents successful completion; the remaining values reserve the
 * non-success outcomes needed by the command boundary.
 */
export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * A stable classification for an Ambercast failure.
 *
 * The classification, rather than a message string or a concrete subclass
 * name, is the contract used to select handling policy and a process exit
 * status.
 */
export type ErrorKind =
  | 'assertion-failed'
  | 'config-invalid'
  | 'secret-unresolved'
  | 'target-unresolved'
  | 'secret-literal-rejected'
  | 'secret-grant-unattributable'
  | 'missing-plan'
  | 'stale-ir'
  | 'integrity-violation'
  | 'browser-launch-failed'
  | 'ai-executor-unavailable'
  | 'ai-response-invalid'
  | 'fs-io-error'
  | 'unexpected-crash'
  | 'no-tests-found';

/**
 * Base class for failures that participate in Ambercast's classified error
 * contract.
 *
 * A concrete error supplies its classification while this base preserves the
 * original message, optional structured context, and causal error chain for
 * callers that need to report or diagnose the failure.
 */
export abstract class AmbercastError extends Error {
  /**
   * Classifies this failure for policy and exit-status selection.
   */
  abstract readonly kind: ErrorKind;

  /**
   * Gets the non-success process status associated with this error.
   *
   * @remarks
   * The getter resolves the classification through the central error-to-exit-
   * code table, so every concrete error follows one authoritative mapping.
   */
  get exitCode(): ErrorExitCode {
    return ERROR_EXIT_CODES[this.kind];
  }

  /**
   * Creates a classified error while retaining diagnostic context from the
   * failure boundary.
   *
   * @param message - A human-readable explanation suitable for diagnostics.
   * @param details - Optional structured context that concrete errors can
   *   expose without forcing a shared, prematurely narrow details shape.
   * @param options - Standard error options whose `cause` retains the original
   *   failure when one exists.
   */
  constructor(
    message: string,
    /**
     * Optional structured context retained with the error for diagnostics.
     */
    readonly details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
