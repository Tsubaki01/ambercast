/**
 * Captures the reason a test operation rejects.
 *
 * Negative-path assertions need the original rejection value so they can
 * inspect structured diagnostics; resolving successfully is therefore a
 * fixture error rather than a value this helper can return.
 *
 * @param operation - Operation expected to reject.
 * @returns The rejection value produced by the operation.
 * @throws When the operation resolves instead of rejecting.
 */
export async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }

  throw new Error('Expected the operation to reject.');
}
