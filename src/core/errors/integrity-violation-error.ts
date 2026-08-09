/*
 * Provides the classified trust-boundary failure for generated artifacts that
 * cannot be accepted as authored replay instructions.
 */

import { AmbercastError } from './types.js';

/**
 * Reports a plan artifact that is invalid or non-canonical and cannot be trusted.
 *
 * @remarks
 * A plan or grounding document crosses into replay only when its structure
 * and references can be trusted as authored: a step that references an
 * unknown ID, or another replay-boundary integrity check, fails this
 * contract. Replay fails closed because malformed content must not direct a
 * browser action. Stale IR also fails closed, but describes an artifact that
 * remains trustworthy in shape while being outdated; callers need that
 * distinction to choose the correct recovery.
 */
export class IntegrityViolationError extends AmbercastError {
  readonly kind = 'integrity-violation' as const;
}
