import type { AmbercastError, ErrorKind } from '#core/errors/types.js';
import type { ReportError, ReportErrorCode } from './schema.js';

/**
 * Maps classified Ambercast errors to stable report classifications and codes.
 *
 * @remarks
 * All report builders use this identical `ErrorKind` to `{ kind, code }`
 * correspondence. Keeping it here prevents drift between hand-maintained
 * command tables. Interruption maps to the stable environment vocabulary but
 * remains a run-only condition; the conversion boundary rejects any attempt
 * to attach it to a case. Its process status still comes only from
 * `ERROR_EXIT_CODES`, while each interrupted report builder creates exactly
 * one `{ scope: 'run', kind: 'environment', code: 'INTERRUPTED' }` entry. The
 * `test/unit/report/error-code-correspondence.test.ts` contract test pins
 * `ERROR_EXIT_CODES` and `ReportErrorCode` directly, so the correspondence is
 * not coupled to a particular report builder as its home.
 */
export const REPORT_ERROR_DETAILS = {
  'config-invalid': { kind: 'usage', code: 'CONFIG_INVALID' },
  'secret-unresolved': { kind: 'usage', code: 'SECRET_UNRESOLVED' },
  'target-unresolved': { kind: 'usage', code: 'TARGET_UNRESOLVED' },
  'secret-literal-rejected': { kind: 'usage', code: 'SECRET_LITERAL_REJECTED' },
  'secret-grant-unattributable': { kind: 'usage', code: 'SECRET_GRANT_UNATTRIBUTABLE' },
  'missing-plan': { kind: 'usage', code: 'MISSING_PLAN' },
  'stale-ir': { kind: 'usage', code: 'STALE_PLAN' },
  'integrity-violation': { kind: 'usage', code: 'INTEGRITY_VIOLATION' },
  'browser-launch-failed': { kind: 'environment', code: 'BROWSER_LAUNCH_FAILED' },
  'ai-executor-unavailable': { kind: 'environment', code: 'AI_EXECUTOR_UNAVAILABLE' },
  'ai-response-invalid': { kind: 'environment', code: 'AI_RESPONSE_INVALID' },
  'fs-io-error': { kind: 'environment', code: 'FS_IO_ERROR' },
  'unexpected-crash': { kind: 'environment', code: 'UNEXPECTED_CRASH' },
  interrupted: { kind: 'environment', code: 'INTERRUPTED' },
} as const satisfies Partial<Record<ErrorKind, { readonly kind: 'usage' | 'environment'; readonly code: ReportErrorCode }>>;

/**
 * Converts a classified error into a serializable run- or case-scoped report
 * error.
 *
 * @param error - The classified failure to serialize.
 * @param location - The report scope, including a case identifier when needed.
 * @returns The stable report error corresponding to the classified failure.
 * @throws {Error} If the error kind has no report-code correspondence, or if
 * interruption is requested at case scope. The latter guard keeps batch
 * cancellation from inflating case-error accounting.
 */
export function reportError(error: AmbercastError, location: { readonly scope: 'run' }): ReportError;
export function reportError(error: AmbercastError, location: { readonly scope: 'case'; readonly caseId: string }): ReportError;
export function reportError(
  error: AmbercastError,
  location: { readonly scope: 'run' } | { readonly scope: 'case'; readonly caseId: string },
): ReportError {
  const details = REPORT_ERROR_DETAILS[error.kind as keyof typeof REPORT_ERROR_DETAILS];
  if (details === undefined) {
    throw new Error(`Error kind ${error.kind} cannot be serialized as a report error.`);
  }
  if (error.kind === 'interrupted' && location.scope === 'case') {
    throw new Error('Error kind interrupted cannot be serialized at case scope.');
  }

  return (location.scope === 'run'
    ? { scope: location.scope, ...details, message: error.message }
    : { scope: location.scope, ...details, caseId: location.caseId, message: error.message }) as ReportError;
}
