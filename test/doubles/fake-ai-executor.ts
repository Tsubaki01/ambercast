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

export function createFakeAiExecutor(_options: FakeAiExecutorOptions = {}): AiExecutor {
  return {
    name: 'codex-cli',
    async execute<T>(_request: AiExecuteRequest): Promise<AiExecuteResult<T>> {
      throw new Error('not implemented');
    },
    async executeAgentic(_request: AiAgenticRequest): Promise<AiAgenticResult> {
      throw new Error('not implemented');
    },
    async isAvailable(): Promise<boolean> {
      throw new Error('not implemented');
    },
  };
}
