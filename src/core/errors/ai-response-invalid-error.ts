/*
 * Provides the one classified failure shared by adapter-boundary and
 * usecase-boundary validation of a provider's structured response.
 */

import { AmbercastError } from './types.js';

/**
 * Reports structured AI output that cannot satisfy its declared contract.
 *
 * @remarks
 * Callers supply details shaped as `{ raw, issues }`, where `raw` is the
 * unparsed provider text and every issue identifies a path and message. The
 * shared classification makes malformed JSON, schema violations, and the
 * final plan validation failure report consistently without exposing those
 * response details as separate error categories.
 */
export class AiResponseInvalidError extends AmbercastError {
  readonly kind = 'ai-response-invalid' as const;
}
