import type { BrowserSession } from '../../../src/ports/browser.js';
import type { AiExecuteRequest, AiExecuteResult } from '../../../src/ports/ai.js';
import { registerAiExecutorContract } from '../../contracts/ai-executor.contract.js';
import { registerBrowserDriverContract } from '../../contracts/browser-driver.contract.js';
import { registerBrowserSessionContract } from '../../contracts/browser-session.contract.js';
import { registerClockContract } from '../../contracts/clock.contract.js';
import { registerEnvironmentInfoContract } from '../../contracts/environment-info.contract.js';
import { registerEventSinkContract } from '../../contracts/event-sink.contract.js';
import { registerRandomSourceContract } from '../../contracts/random-source.contract.js';
import { registerSecretsProviderContract } from '../../contracts/secrets-provider.contract.js';
import { registerStorageContract } from '../../contracts/storage.contract.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createFixedRandom } from '../../doubles/create-fixed-random.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeAiActionController } from '../../doubles/fake-ai-action-controller.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession, elementRefKey } from '../../doubles/fake-browser-session.js';
import { createFakeEnvironmentInfo } from '../../doubles/fake-environment-info.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

function sessionKey(ref: { readonly strategy: 'accessibility'; readonly role: string; readonly name: string }): string {
  return elementRefKey(ref);
}

function createContractSession(): BrowserSession {
  return createFakeBrowserSession(new Map());
}

registerBrowserSessionContract({
  createSession: (setup) => createFakeBrowserSession(new Map([[
    sessionKey(setup.ref),
    { currentFingerprint: setup.currentFingerprint, exists: setup.exists },
  ]])),
});

registerBrowserDriverContract({
  createDriver: () => createFakeBrowserDriver(createContractSession),
});

registerAiExecutorContract({
  createExecutor: (scripted) => createFakeAiExecutor({
    execute: <T>(request: AiExecuteRequest<T>) => {
      if (scripted.executeError !== undefined) {
        throw scripted.executeError;
      }

      return typeof scripted.execute === 'function'
        ? scripted.execute(request as AiExecuteRequest<unknown>) as AiExecuteResult<T>
        : scripted.execute as AiExecuteResult<T>;
    },
    executeAgentic: (request) => typeof scripted.executeAgentic === 'function'
      ? scripted.executeAgentic(request)
      : scripted.executeAgentic,
    available: true,
  }),
  createActionController: createFakeAiActionController,
});

registerStorageContract({
  createStorage: createInMemoryStorage,
});

registerClockContract({
  createClock: () => createFixedClock(new Date('2026-08-03T00:00:00.000Z'), 42),
});

registerRandomSourceContract({
  createRandom: () => createFixedRandom('123e4567-e89b-42d3-a456-426614174000', 0.5),
});

registerSecretsProviderContract({
  createSecrets: (known) => createFakeSecretsProvider(new Map([[known.ref, known.value]])),
});

registerEnvironmentInfoContract({
  createEnvironment: createFakeEnvironmentInfo,
});

registerEventSinkContract({
  createSink: createRecordingEventSink,
});
