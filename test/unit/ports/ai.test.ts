import { describe, expectTypeOf, it } from 'vitest';
import type { JsonValueT } from '../../../src/core/ir/schema.js';
import type {
  AiActionController,
  AiAgenticRequest,
  AiAgenticResult,
  AiExecuteRequest,
  AiExecuteResult,
  AiExecutor,
  AiUsage,
  JsonSchema,
} from '../../../src/ports/ai.js';
import type { BrowserSession, PerformableAction } from '../../../src/ports/browser.js';

describe('AI port shapes', () => {
  it('defines structured-response request, result, usage, and schema types', () => {
    expectTypeOf<JsonSchema>().toEqualTypeOf<Record<string, unknown>>();
    expectTypeOf<AiUsage>().toEqualTypeOf<{ readonly inputTokens?: number; readonly outputTokens?: number }>();
    expectTypeOf<AiExecuteRequest>().toEqualTypeOf<{
      readonly prompt: string;
      readonly responseSchema: JsonSchema;
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
    expectTypeOf<AiActionController>().toEqualTypeOf<Pick<
      BrowserSession,
      'perform' | 'evaluateAssert' | 'snapshotForResolution'
    >>();
    expectTypeOf<AiAgenticRequest>().toEqualTypeOf<{
      readonly instructionPrompt: string;
      readonly controller: AiActionController;
      readonly priorTrace?: readonly PerformableAction[];
      readonly signal?: AbortSignal;
    }>();
    expectTypeOf<AiAgenticResult>().toEqualTypeOf<{
      readonly trace: readonly PerformableAction[];
      readonly outcome: 'success' | 'failure';
      readonly usage?: AiUsage;
    }>();
  });

  it('keeps structured and agentic execution as distinct exact signatures', () => {
    expectTypeOf<AiExecutor['name']>().toEqualTypeOf<'claude-code-cli' | 'codex-cli'>();
    expectTypeOf<AiExecutor['execute']>().toEqualTypeOf<
      <T>(request: AiExecuteRequest) => Promise<AiExecuteResult<T>>
    >();
    expectTypeOf<AiExecutor['executeAgentic']>().toEqualTypeOf<
      (request: AiAgenticRequest) => Promise<AiAgenticResult>
    >();
    expectTypeOf<AiExecutor['isAvailable']>().toEqualTypeOf<() => Promise<boolean>>();
  });
});
