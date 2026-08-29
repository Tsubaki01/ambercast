import { describe, expectTypeOf, it } from 'vitest';
import type { StepId } from '../../../src/core/ir/schema.js';
import type {
  Clock,
  EnvironmentInfo,
  EventSink,
  RandomSource,
  RunEvent,
  SecretsProvider,
} from '../../../src/ports/system.js';

describe('system port shapes', () => {
  it('defines time, randomness, secret, and environment operations', () => {
    expectTypeOf<Clock['now']>().toEqualTypeOf<() => Date>();
    expectTypeOf<Clock['monotonicMs']>().toEqualTypeOf<() => number>();
    expectTypeOf<RandomSource['uuid']>().toEqualTypeOf<() => string>();
    expectTypeOf<RandomSource['float']>().toEqualTypeOf<() => number>();
    expectTypeOf<SecretsProvider['resolve']>().toEqualTypeOf<(ref: string) => string | undefined>();
    expectTypeOf<EnvironmentInfo['isCI']>().toEqualTypeOf<() => boolean>();
  });

  it('defines run-event variants and the synchronous event sink', () => {
    expectTypeOf<RunEvent>().toEqualTypeOf<
      | { readonly type: 'step-start'; readonly stepId: StepId }
      | { readonly type: 'step-result'; readonly stepId: StepId; readonly via: 'grounding' | 'ai-resolve' | 'trace-replay' }
      | { readonly type: 'ai-call'; readonly stepId?: StepId }
      | {
        readonly type: 'heal-stage2-rejected';
        readonly stepId: StepId;
        readonly reason: 'provider-error' | 'response-shape' | 'id-mismatch' | 'secret-attribution' | 'coverage-invalid' | 'obligation-mismatch' | 'literal-secret' | 'no-advance';
      }
    >();
    expectTypeOf<EventSink['emit']>().toEqualTypeOf<(event: RunEvent) => void>();
  });
});
