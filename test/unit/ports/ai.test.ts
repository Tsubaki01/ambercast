import { describe, expectTypeOf, it } from 'vitest';
import type {
  ElementRef,
  InstructionCriterionId,
  JsonValueT,
  RunVariableName,
  SecretRef,
  TraceAction,
  TraceAssert,
  TraceRecord,
} from '../../../src/core/ir/schema.js';
import type { TypedJsonSchema } from '../../../src/core/ai/typed-json-schema.js';
import type {
  AiActionController,
  AiAgenticRequest,
  AiAgenticResult,
  AiExecuteRequest,
  AiExecuteResult,
  AiExecutor,
  AiTrustedInstructionCriterion,
  InstructionCoverageAiActionController,
  InstructionCoveredAiAgenticRequest,
  InstructionCoveredAiExecutor,
  SafeLegacyTraceRecord,
  AiResolutionSnapshot,
  AiUsage,
} from '../../../src/ports/ai.js';
import { createClaudeCodeCliExecutor } from '../../../src/adapters/ai/claude-code-cli/index.js';
import { createCodexCliExecutor } from '../../../src/adapters/ai/codex-cli/index.js';
import { AI_EXECUTOR_FACTORIES } from '../../../src/adapters/ai/registry.js';
import type {
  AssertCheck,
  AssertOutcome,
  BrowserSession,
  PageSnapshot,
  PerformableAction,
} from '../../../src/ports/browser.js';

type PerformableActionController = {
  perform(action: PerformableAction): Promise<void>;
  evaluateAssert(check: AssertCheck): Promise<AssertOutcome>;
  snapshotForResolution(): Promise<PageSnapshot>;
};

/**
 * Keeps the branded request/schema association in the compiler's test set.
 *
 * The deliberate error is type-only: a schema for `{ ok }` must not be
 * accepted when a caller asks an executor for an unrelated `{ nope }` value.
 */
function expectMismatchedSchemaToFail(
  executor: AiExecutor,
  schema: TypedJsonSchema<{ readonly ok: boolean }>,
): void {
  // @ts-expect-error A schema's required brand must agree with execute<T>.
  void executor.execute<{ readonly nope: string }>({ prompt: 'Return nope.', responseSchema: schema });
}

void expectMismatchedSchemaToFail;

describe('AI port shapes', () => {
  it('defines structured-response request, result, usage, and schema types', () => {
    expectTypeOf<AiUsage>().toEqualTypeOf<{ readonly inputTokens?: number; readonly outputTokens?: number }>();
    expectTypeOf<AiExecuteRequest<{ readonly ok: boolean }>>().toEqualTypeOf<{
      readonly prompt: string;
      readonly responseSchema: TypedJsonSchema<{ readonly ok: boolean }>;
      readonly context?: JsonValueT;
      readonly signal?: AbortSignal;
    }>();
    expectTypeOf<AiExecuteResult<{ readonly ok: boolean }>>().toEqualTypeOf<{
      readonly data: { readonly ok: boolean };
      readonly raw: string;
      readonly usage?: AiUsage;
    }>();
  });

  it('defines the narrow controller and agentic request/result shapes', () => {
    expectTypeOf<AiActionController>().toEqualTypeOf<{
      perform(action: TraceAction): Promise<void>;
      evaluateAssert(check: TraceAssert): Promise<AssertOutcome>;
      snapshotForResolution(): Promise<AiResolutionSnapshot>;
    }>();
    expectTypeOf<AiResolutionSnapshot>().toEqualTypeOf<{
      readonly accessibilityTree: JsonValueT;
    }>();
    expectTypeOf<AiAgenticRequest>().toEqualTypeOf<{
      readonly instructionPrompt: string;
      readonly allowedSecretRefs: readonly SecretRef[];
      readonly allowedRunRefs: readonly RunVariableName[];
      readonly controller: AiActionController;
      readonly priorTrace?: TraceRecord;
      readonly signal?: AbortSignal;
    }>();
    expectTypeOf<AiAgenticResult>().toEqualTypeOf<{
      readonly outcome: 'success' | 'failure';
      readonly usage?: AiUsage;
    }>();
    expectTypeOf<BrowserSession>().not.toExtend<AiActionController>();
    expectTypeOf<PerformableActionController>().not.toExtend<AiActionController>();
    // Structural assignability allows excess properties: this only excludes shapes missing `secretRef`; `secretRef` plus stray `value` is rejected by `TraceFillSecret`'s `z.strictObject` at parse time (schema.test.ts).
    expectTypeOf<{
      type: 'fill-secret';
      target: ElementRef;
      value: string;
    }>().not.toExtend<TraceAction>();
  });

  it('keeps structured and agentic execution as distinct exact signatures', () => {
    expectTypeOf<AiExecutor['name']>().toEqualTypeOf<'claude-code-cli' | 'codex-cli'>();
    expectTypeOf<AiExecutor['execute']>().toEqualTypeOf<
      <T>(request: AiExecuteRequest<T>) => Promise<AiExecuteResult<T>>
    >();
    expectTypeOf<AiExecutor['executeAgentic']>().toEqualTypeOf<
      (request: AiAgenticRequest) => Promise<AiAgenticResult>
    >();
    expectTypeOf<AiExecutor['isAvailable']>().toEqualTypeOf<(signal?: AbortSignal) => Promise<boolean>>();
  });

  it('narrows instruction-covered agentic authority to local criteria and safe legacy recovery', () => {
    expectTypeOf<InstructionCoverageAiActionController['evaluateAssert']>().toEqualTypeOf<
      (check: TraceAssert, criterionId?: InstructionCriterionId) => Promise<AssertOutcome>
    >();
    expectTypeOf<InstructionCoveredAiAgenticRequest>().toMatchTypeOf<{
      readonly instructionPrompt: string;
      readonly allowedSecretRefs: readonly SecretRef[];
      readonly allowedRunRefs: readonly RunVariableName[];
      readonly trustedInstructionCoverage: readonly AiTrustedInstructionCriterion[];
      readonly controller: InstructionCoverageAiActionController;
      readonly priorTrace?: SafeLegacyTraceRecord;
      readonly signal?: AbortSignal;
    }>();
    expectTypeOf<InstructionCoveredAiAgenticRequest>()
      .not.toHaveProperty('verificationIntent');
  });

  it('preserves the instruction-covered executor type through concrete factories and registry lookup', () => {
    expectTypeOf(createClaudeCodeCliExecutor()).toEqualTypeOf<InstructionCoveredAiExecutor>();
    expectTypeOf(createCodexCliExecutor()).toEqualTypeOf<InstructionCoveredAiExecutor>();
    expectTypeOf(AI_EXECUTOR_FACTORIES.claude({ run: async () => ({
      outcome: 'exited', stdout: '', stderr: '', exitCode: 0,
    }) })).toEqualTypeOf<InstructionCoveredAiExecutor>();
    expectTypeOf(AI_EXECUTOR_FACTORIES.codex({ run: async () => ({
      outcome: 'exited', stdout: '', stderr: '', exitCode: 0,
    }) })).toEqualTypeOf<InstructionCoveredAiExecutor>();
  });
});
