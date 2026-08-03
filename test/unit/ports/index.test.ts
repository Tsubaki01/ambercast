import { describe, expectTypeOf, it } from 'vitest';
import type { AiExecutor } from '../../../src/ports/ai.js';
import type { BrowserDriver, BrowserEngine } from '../../../src/ports/browser.js';
import type { BrowserDriverResolver, Ports } from '../../../src/ports/index.js';
import type { StorageAdapter } from '../../../src/ports/storage.js';
import type { Clock, EnvironmentInfo, EventSink, RandomSource, SecretsProvider } from '../../../src/ports/system.js';

describe('Ports aggregate shape', () => {
  it('keeps browser selection as a resolver and all dependencies readonly direct instances', () => {
    expectTypeOf<BrowserDriverResolver>().toEqualTypeOf<(engine: BrowserEngine) => BrowserDriver>();
    expectTypeOf<Ports>().toEqualTypeOf<{
      readonly browserDriver: BrowserDriverResolver;
      readonly aiExecutor: AiExecutor;
      readonly storage: StorageAdapter;
      readonly clock: Clock;
      readonly random: RandomSource;
      readonly secrets: SecretsProvider;
      readonly environment: EnvironmentInfo;
      readonly events: EventSink;
    }>();
  });
});
