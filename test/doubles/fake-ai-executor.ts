import type {
  AiAgenticRequest,
  AiAgenticResult,
  AiExecuteRequest,
  AiExecuteResult,
  AiExecutor,
} from '../../src/ports/ai.js';

export interface FakeAiExecutorOptions {
  readonly execute?: (request: AiExecuteRequest) => AiExecuteResult<unknown> | Promise<AiExecuteResult<unknown>>;
  readonly executeAgentic?: (request: AiAgenticRequest) => AiAgenticResult | Promise<AiAgenticResult>;
  readonly cannedResponses?: ReadonlyMap<string, AiExecuteResult<unknown>>;
  readonly available?: boolean;
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
export function createFakeAiExecutor(options: FakeAiExecutorOptions = {}): AiExecutor {
  return {
    name: 'codex-cli',
    async execute<T>(request: AiExecuteRequest): Promise<AiExecuteResult<T>> {
      if (options.execute !== undefined) {
        return await options.execute(request) as AiExecuteResult<T>;
      }

      if (typeof request.context !== 'string') {
        throw new Error('Unscripted AI execute request: context must be a string canned-response key');
      }

      const cannedResponse = options.cannedResponses?.get(request.context);
      if (cannedResponse === undefined) {
        throw new Error(`Unscripted AI execute request for context key: ${request.context}`);
      }

      return cannedResponse as AiExecuteResult<T>;
    },
    async executeAgentic(request: AiAgenticRequest): Promise<AiAgenticResult> {
      if (options.executeAgentic === undefined) {
        throw new Error('No override configured for executeAgentic');
      }

      return options.executeAgentic(request);
    },
    async isAvailable(): Promise<boolean> {
      return options.available ?? true;
    },
  };
}
