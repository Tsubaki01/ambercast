import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserDriverResolver } from '#adapters/browser/registry.js';
import type { CommandRunner } from '#adapters/ai/shared/command-runner.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { createAmbercast } from '#runtime/create-ambercast.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession } from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const mocks = vi.hoisted(() => ({
  claudeFactory: vi.fn(() => ({ name: 'claude-code-cli' })),
  codexFactory: vi.fn(() => ({ name: 'codex-cli' })),
  readCommandEnvironment: vi.fn(),
}));

vi.mock('#adapters/ai/registry.js', () => ({
  AI_EXECUTOR_FACTORIES: { claude: mocks.claudeFactory, codex: mocks.codexFactory },
}));
vi.mock('#adapters/system/process-command-environment.js', () => ({
  readCommandEnvironment: mocks.readCommandEnvironment,
}));

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests',
  runsDir: '/workspace/tests/.runs',
  projectRoot: '/workspace',
  testMatch: ['**/*.test.md'],
  testIgnore: ['**/.runs/**'],
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium', healReplayIsolation: 'stateful' } },
  defaultTarget: 'web',
  ai: { provider: 'codex', timeoutMs: 120_000 },
  viewer: { port: 4600 },
  ci: { heal: false, updateGroundingCache: false },
  grounding: { repositoryPolicy: 'committed', localWriteBack: 'auto' },
  heal: { caseTimeoutMs: 300_000 },
};

afterEach(() => {
  vi.clearAllMocks();
});

interface FactoryCallRecorder {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}

function hasCommandRunner(value: unknown): value is { readonly run: CommandRunner } {
  return value !== null
    && typeof value === 'object'
    && 'run' in value
    && typeof value.run === 'function';
}

function capturedRunner(factory: FactoryCallRecorder): CommandRunner {
  const deps = factory.mock.calls[0]?.[0];

  if (!hasCommandRunner(deps)) {
    throw new Error('Expected the executor factory to receive a command runner.');
  }

  return deps.run;
}

describe('createAmbercast', () => {
  it.each([
    ['claude', 'claude-code-cli'],
    ['codex', 'codex-cli'],
  ] as const)('composes the narrow generation service set for %s', (provider, executorName) => {
    const ambercast = createAmbercast({ config: CONFIG, aiProvider: provider, events: createRecordingEventSink().sink });

    expect(ambercast.aiExecutor.name).toBe(executorName);
    expect(typeof ambercast.storage.readText).toBe('function');
    expect(typeof ambercast.layout.planPathFor).toBe('function');
    expect(typeof ambercast.clock.now).toBe('function');
    expect(typeof ambercast.discoverTestFiles).toBe('function');
  });

  it.each([
    ['claude', mocks.claudeFactory],
    ['codex', mocks.codexFactory],
  ] as const)('injects an environment-filtered runner into the %s executor factory', async (provider, factory) => {
    const commandEnvironment = {
      AMBERCAST_RUNTIME_ALLOWED: 'allowed',
      AMBERCAST_SECRET_RUNTIME_TEST: 'secret',
    };
    mocks.readCommandEnvironment.mockReturnValue(commandEnvironment);

    createAmbercast({ config: CONFIG, aiProvider: provider, events: createRecordingEventSink().sink });

    expect(mocks.readCommandEnvironment).toHaveBeenCalledExactlyOnceWith();
    const result = await capturedRunner(factory)(process.execPath, [
      '--input-type=module',
      '--eval',
      'process.stdout.write(JSON.stringify(process.env));',
    ]);

    expect(result).toMatchObject({ outcome: 'exited', exitCode: 0 });
    if (result.outcome !== 'exited') {
      throw new Error('Expected the environment probe child to exit normally.');
    }

    const childEnvironment = JSON.parse(result.stdout) as NodeJS.ProcessEnv;
    expect(childEnvironment.AMBERCAST_RUNTIME_ALLOWED).toBe('allowed');
    expect(childEnvironment).not.toHaveProperty('AMBERCAST_SECRET_RUNTIME_TEST');
  });

  it('uses resolved configuration roots for storage layout rather than creating unrelated port stand-ins', () => {
    const ambercast = createAmbercast({ config: CONFIG, aiProvider: 'codex', events: createRecordingEventSink().sink });

    expect(ambercast.layout.planPathFor('/workspace/tests/nested/login.test.md'))
      .toBe('/workspace/tests/nested/login.ambercast.plan.json');
  });

  it('keeps a headed Chromium resolver intact so replay resolves through the driver registry', () => {
    const browserDriver = createBrowserDriverResolver({ headed: true });
    const ambercast = createAmbercast({
      config: CONFIG,
      aiProvider: 'codex',
      browserDriver,
      events: createRecordingEventSink().sink,
    });

    expect(ambercast.browserDriver).toBe(browserDriver);
    expect(ambercast.browserDriver?.('chromium').engine).toBe('chromium');
  });

  it('omits browser driver when generation has none', () => {
    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex', events: createRecordingEventSink().sink }).browserDriver).toBeUndefined();
  });

  it('retains supplied secrets and omits them when generation has none', () => {
    const secrets = createFakeSecretsProvider(new Map([['{{secrets.auth.password}}', 'secret']]));

    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex', secrets, events: createRecordingEventSink().sink }).secrets).toBe(secrets);
    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex', events: createRecordingEventSink().sink }).secrets).toBeUndefined();
  });

  it('passes the supplied events sink through unchanged', () => {
    const events = createRecordingEventSink();

    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex', events: events.sink }).events).toBe(events.sink);
  });

  it('constructs its AI executor even when every replay-specific port is supplied', () => {
    const browserDriver = () => createFakeBrowserDriver(() => createFakeBrowserSession(new Map()));
    const secrets = createFakeSecretsProvider(new Map());
    const events = createRecordingEventSink();

    const ambercast = createAmbercast({
      config: CONFIG,
      aiProvider: 'claude',
      browserDriver,
      secrets,
      events: events.sink,
    });

    expect(ambercast.aiExecutor.name).toBe('claude-code-cli');
    expect(ambercast.browserDriver).toBe(browserDriver);
    expect(ambercast.secrets).toBe(secrets);
    expect(ambercast.events).toBe(events.sink);
  });
});
