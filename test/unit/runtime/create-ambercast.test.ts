import { describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '#core/config/schema.js';
import { createAmbercast } from '#runtime/create-ambercast.js';

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
});
