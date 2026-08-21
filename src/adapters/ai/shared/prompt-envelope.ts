/**
 * Adapts core prompt framing to the two AI-port request shapes.
 *
 * The grammar and its provenance fingerprint live in core because generation
 * and transport must share them without crossing the usecase-to-adapter
 * boundary. This module retains the provider-facing structured and agentic
 * request helpers.
 */

import {
  buildAgenticPromptEnvelope,
  buildPromptEnvelope,
} from '#core/ai/prompt-envelope.js';
import type {
  JsonValueT,
  RunVariableName,
  SecretRef,
  TraceRecord,
} from '#core/ir/schema.js';
import type { InstructionCoveredAiAgenticRequest } from '#ports/ai.js';

export {
  PROMPT_ENVELOPE_TEMPLATE,
  promptTemplateFingerprint,
} from '#core/ai/prompt-envelope.js';

/**
 * Builds the isolated envelope for a structured generation request.
 *
 * @param request - Task text and optional serializable caller context.
 * @returns The shared fixed framing followed by task and JSON context sections.
 */
export function buildStructuredPrompt(request: {
  readonly prompt: string;
  readonly context?: JsonValueT;
}): string {
  return buildPromptEnvelope(request.prompt, request.context);
}

/**
 * Provider-facing prompt input with mandatory instruction coverage.
 *
 * The controller and cancellation signal remain transport capabilities and do
 * not enter prompt context. Trusted criteria are locally re-extracted, while
 * provider-authored citation and transient-intent fields are absent by type.
 */
export type InstructionCoveredAgenticPromptRequest = Pick<
  InstructionCoveredAiAgenticRequest,
  'instructionPrompt' | 'allowedSecretRefs' | 'allowedRunRefs' |
  'trustedInstructionCoverage' | 'priorTrace'
> & {
  /** Optional provider evidence nested below the untrusted context key. */
  readonly context?: JsonValueT;
};

/**
 * Builds a criterion-aware agentic prompt without changing Plan freshness.
 *
 * @param request - Trusted Plan metadata, safe legacy recovery, and evidence.
 * @returns Common injection framing plus agentic-only criterion policy.
 * @remarks
 * The renderer places locally derived criteria under `trustedPlanMetadata`,
 * alongside secret and run grants. Safe legacy evidence and other provider
 * context cannot occupy that authority-bearing path. The renderer uses the
 * nonfingerprinted agentic policy partition; local journal validation
 * remains authoritative when the model fails to follow its wording.
 */
export function buildInstructionCoveredAgenticPrompt(
  request: InstructionCoveredAgenticPromptRequest,
): string {
  return buildAgenticPromptEnvelope(request.instructionPrompt, {
    trustedPlanMetadata: {
      allowedSecretRefs: request.allowedSecretRefs,
      allowedRunRefs: request.allowedRunRefs,
      trustedInstructionCoverage: request.trustedInstructionCoverage,
    },
    ...(request.priorTrace === undefined ? {} : { priorTrace: request.priorTrace }),
    ...(request.context === undefined ? {} : { untrustedContext: request.context }),
  });
}

/**
 * Builds the isolated envelope for a browser-directed agentic request.
 *
 * Trusted plan grants occupy a fixed top-level metadata object. Other caller
 * data remains nested under `untrustedContext`, so snapshots and DOM content
 * cannot occupy the authority-bearing path even when they mimic its fields.
 *
 * @param request - Agentic instruction, trusted grants, and optional evidence.
 * @returns The shared fixed framing followed by task and JSON context sections.
 */
export function buildAgenticPrompt(request: {
  readonly instructionPrompt: string;
  readonly allowedSecretRefs: readonly SecretRef[];
  readonly allowedRunRefs: readonly RunVariableName[];
  readonly priorTrace?: TraceRecord;
  readonly context?: JsonValueT;
}): string {
  return buildPromptEnvelope(request.instructionPrompt, {
    trustedPlanMetadata: {
      allowedSecretRefs: request.allowedSecretRefs,
      allowedRunRefs: request.allowedRunRefs,
    },
    ...(request.priorTrace === undefined ? {} : { priorTrace: request.priorTrace }),
    ...(request.context === undefined ? {} : { untrustedContext: request.context }),
  });
}
