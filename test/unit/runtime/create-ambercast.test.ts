import { describe, expect, it } from 'vitest';
import { createBrowserDriverResolver } from '#adapters/browser/registry.js';
import type { ResolvedConfig } from '#core/config/schema.js';
import { createAmbercast } from '#runtime/create-ambercast.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import { createFakeBrowserSession } from '../../doubles/fake-browser-session.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';

const CONFIG: ResolvedConfig = {
  testDir: '/workspace/tests',
  runsDir: '/workspace/tests/.runs',
  testMatch: ['**/*.test.md'],
  testIgnore: ['**/.runs/**'],
  targets: { web: { baseUrl: 'https://example.test', browser: 'chromium' } },
  defaultTarget: 'web',
  ai: { provider: 'codex', timeoutMs: 120_000 },
  viewer: { port: 4600 },
  ci: { heal: false, updateGroundingCache: false },
};

describe('createAmbercast', () => {
  it.each([
    ['claude', 'claude-code-cli'],
    ['codex', 'codex-cli'],
  ] as const)('composes the narrow generation service set for %s', (provider, executorName) => {
    const ambercast = createAmbercast({ config: CONFIG, aiProvider: provider });

    expect(ambercast.aiExecutor.name).toBe(executorName);
    expect(typeof ambercast.storage.readText).toBe('function');
    expect(typeof ambercast.layout.planPathFor).toBe('function');
    expect(typeof ambercast.clock.now).toBe('function');
    expect(typeof ambercast.discoverTestFiles).toBe('function');
  });

  it('uses resolved configuration roots for storage layout rather than creating unrelated port stand-ins', () => {
    const ambercast = createAmbercast({ config: CONFIG, aiProvider: 'codex' });

    expect(ambercast.layout.planPathFor('/workspace/tests/nested/login.test.md'))
      .toBe('/workspace/tests/nested/login.ambercast.plan.json');
  });

  it('keeps a headed Chromium resolver intact so replay resolves through the driver registry', () => {
    const browserDriver = createBrowserDriverResolver({ headed: true });
    const ambercast = createAmbercast({ config: CONFIG, aiProvider: 'codex', browserDriver });

    expect(ambercast.browserDriver).toBe(browserDriver);
    expect(ambercast.browserDriver?.('chromium').engine).toBe('chromium');
  });

  it('omits browser driver when generation has none', () => {
    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex' }).browserDriver).toBeUndefined();
  });

  it('retains supplied secrets and omits them when generation has none', () => {
    const secrets = createFakeSecretsProvider(new Map([['{{secrets.auth.password}}', 'secret']]));

    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex', secrets }).secrets).toBe(secrets);
    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex' }).secrets).toBeUndefined();
  });

  it('retains supplied events and omits them when generation has none', () => {
    const events = createRecordingEventSink();

    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex', events: events.sink }).events).toBe(events.sink);
    expect(createAmbercast({ config: CONFIG, aiProvider: 'codex' }).events).toBeUndefined();
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
