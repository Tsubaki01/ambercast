import type {
  AiAgenticResult,
  AiExecuteRequest,
  AiExecuteResult,
  InstructionCoveredAiAgenticRequest,
  InstructionCoveredAiExecutor,
} from '../../src/ports/ai.js';
import { rejectOnAbort } from '../../src/core/ai/reject-on-abort.js';

export interface FakeAiExecutorOptions {
  readonly execute?: (request: AiExecuteRequest<unknown>) => AiExecuteResult<unknown> | Promise<AiExecuteResult<unknown>>;
  readonly executeAgentic?: (
    request: InstructionCoveredAiAgenticRequest,
  ) => AiAgenticResult | Promise<AiAgenticResult>;
  readonly cannedResponses?: ReadonlyMap<string, AiExecuteResult<unknown>>;
  readonly available?: boolean;
}

/**
 * The provider contract plus request histories retained for scenario checks.
 *
 * The histories make lazy-fallback and prior-trace assertions observable
 * without asking an individual test to wrap the fake in another recorder.
 */
export interface FakeAiExecutor extends InstructionCoveredAiExecutor {
  readonly structuredRequests: readonly AiExecuteRequest<unknown>[];
  readonly agenticRequests: readonly InstructionCoveredAiAgenticRequest[];
}

/**
 * Creates a deterministic AI-executor double for structured and agentic
 * tests. Explicit handlers take precedence when a scenario needs custom
 * behavior; canned structured results offer concise fixture data for the
 * common case.
 *
 * Canned responses use a caller-supplied string in `request.context`, never
 * the request object's identity, so independently constructed equivalent
 * requests exercise the same scripted interaction.
 *
 * @param options - Handlers, canned structured responses, and availability.
 * @returns An executor that fails loudly for every unscripted operation.
 */
export function createFakeAiExecutor(options: FakeAiExecutorOptions = {}): FakeAiExecutor {
  const structuredRequests: AiExecuteRequest<unknown>[] = [];
  const agenticRequests: InstructionCoveredAiAgenticRequest[] = [];

  return {
    name: 'codex-cli',
    async execute<T>(request: AiExecuteRequest<T>): Promise<AiExecuteResult<T>> {
      return rejectOnAbort(request.signal, async () => {
        structuredRequests.push(request as AiExecuteRequest<unknown>);
        if (options.execute !== undefined) {
          return await options.execute(request as AiExecuteRequest<unknown>) as AiExecuteResult<T>;
        }

        if (typeof request.context !== 'string') {
          throw new Error('Unscripted AI execute request: context must be a string canned-response key');
        }

        const cannedResponse = options.cannedResponses?.get(request.context);
        if (cannedResponse === undefined) {
          throw new Error(`Unscripted AI execute request for context key: ${request.context}`);
        }

        return cannedResponse as AiExecuteResult<T>;
      });
    },
    async executeAgentic(request: InstructionCoveredAiAgenticRequest): Promise<AiAgenticResult> {
      return rejectOnAbort(request.signal, async () => {
        agenticRequests.push(request);
        if (options.executeAgentic === undefined) {
          throw new Error('No override configured for executeAgentic');
        }

        return options.executeAgentic(request);
      });
    },
    async isAvailable(signal?: AbortSignal): Promise<boolean> {
      return rejectOnAbort(signal, async () => options.available ?? true);
    },
    structuredRequests,
    agenticRequests,
  };
}
