/*
 * Provides the classified failure for a storage operation that cannot read or
 * persist an artifact required by the current command.
 */

import { AmbercastError } from './types.js';

/**
 * Reports an I/O failure at the artifact persistence boundary.
 *
 * @remarks
 * A distinct kind lets command reporting preserve the original storage cause
 * while classifying the failure as an execution-environment problem.
 */
export class FsIoError extends AmbercastError {
  readonly kind = 'fs-io-error' as const;
}
