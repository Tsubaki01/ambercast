import { describe, expect, it } from 'vitest';
import { RawConfig } from '#core/config/schema.js';

interface SchemaUnderTest {
  safeParse(value: unknown): { success: boolean };
}

const CONFIG_SCHEMA_URL = 'https://ambercast.dev/schema/config.json';
const TARGET = { baseUrl: 'https://example.test', browser: 'chromium' } as const;

function expectAccepted(schema: SchemaUnderTest, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

function expectRejected(schema: SchemaUnderTest, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

describe('RawConfig', () => {
  it('accepts the minimal present config file', () => {
    expectAccepted(RawConfig, { $schema: CONFIG_SCHEMA_URL });
  });

  it('accepts a complete config file and partial nested overrides', () => {
    expectAccepted(RawConfig, {
      $schema: CONFIG_SCHEMA_URL,
      testDir: 'tests/ambercast',
      runsDir: 'tests/ambercast/.runs',
      testMatch: ['**/*.test.md'],
      testIgnore: ['**/node_modules/**'],
      targets: { app: TARGET },
      defaultTarget: 'app',
      ai: { provider: 'codex' },
      viewer: { port: 4_321 },
      ci: { heal: true, updateGroundingCache: false },
    });
    expectAccepted(RawConfig, {
      $schema: CONFIG_SCHEMA_URL,
      ai: {},
      viewer: {},
      ci: {},
    });
    expectAccepted(RawConfig, { $schema: CONFIG_SCHEMA_URL, ci: { heal: true } });
    expectAccepted(RawConfig, { $schema: CONFIG_SCHEMA_URL, ci: { updateGroundingCache: false } });
  });

  it('accepts empty collection overrides at the raw-schema boundary', () => {
    expectAccepted(RawConfig, {
      $schema: CONFIG_SCHEMA_URL,
      testMatch: [],
      testIgnore: [],
      targets: {},
    });
  });

  it('requires $schema whenever a config file is parsed', () => {
    expectRejected(RawConfig, {});
    expectRejected(RawConfig, { testDir: 'tests/ambercast' });
  });

  it.each([
    ['top level', { $schema: CONFIG_SCHEMA_URL, unexpected: true }],
    ['ai', { $schema: CONFIG_SCHEMA_URL, ai: { provider: 'auto', unexpected: true } }],
    ['viewer', { $schema: CONFIG_SCHEMA_URL, viewer: { port: 3_000, unexpected: true } }],
    ['ci', { $schema: CONFIG_SCHEMA_URL, ci: { heal: true, unexpected: true } }],
    ['target definition', { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, unexpected: true } } }],
  ] as const)('rejects an unknown %s key', (_level, value) => {
    expectRejected(RawConfig, value);
  });

  it.each([
    ['$schema', { $schema: 1 }],
    ['testDir', { $schema: CONFIG_SCHEMA_URL, testDir: 1 }],
    ['runsDir', { $schema: CONFIG_SCHEMA_URL, runsDir: false }],
    ['testMatch', { $schema: CONFIG_SCHEMA_URL, testMatch: '**/*.test.md' }],
    ['testMatch member', { $schema: CONFIG_SCHEMA_URL, testMatch: [1] }],
    ['testIgnore', { $schema: CONFIG_SCHEMA_URL, testIgnore: {} }],
    ['testIgnore member', { $schema: CONFIG_SCHEMA_URL, testIgnore: [false] }],
    ['targets', { $schema: CONFIG_SCHEMA_URL, targets: [] }],
    ['targets.app.baseUrl', { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, baseUrl: 42 } } }],
    ['targets.app.browser', { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, browser: 1 } } }],
    ['defaultTarget', { $schema: CONFIG_SCHEMA_URL, defaultTarget: 1 }],
    ['ai', { $schema: CONFIG_SCHEMA_URL, ai: 'auto' }],
    ['ai.provider', { $schema: CONFIG_SCHEMA_URL, ai: { provider: 1 } }],
    ['viewer', { $schema: CONFIG_SCHEMA_URL, viewer: 3_000 }],
    ['viewer.port', { $schema: CONFIG_SCHEMA_URL, viewer: { port: '3000' } }],
    ['ci', { $schema: CONFIG_SCHEMA_URL, ci: true }],
    ['ci.heal', { $schema: CONFIG_SCHEMA_URL, ci: { heal: 'yes' } }],
    ['ci.updateGroundingCache', { $schema: CONFIG_SCHEMA_URL, ci: { updateGroundingCache: 1 } }],
  ] as const)('rejects a wrong type for %s', (_field, value) => {
    expectRejected(RawConfig, value);
  });

  it('reuses TargetDefinition by accepting only Chromium targets', () => {
    expectAccepted(RawConfig, { $schema: CONFIG_SCHEMA_URL, targets: { app: TARGET } });
    expectRejected(RawConfig, { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, browser: 'firefox' } } });
    expectRejected(RawConfig, { $schema: CONFIG_SCHEMA_URL, targets: { app: { ...TARGET, browser: 'webkit' } } });
  });

  it.each(['claude', 'codex', 'auto'] as const)('accepts %s as an AI provider', (provider) => {
    expectAccepted(RawConfig, { $schema: CONFIG_SCHEMA_URL, ai: { provider } });
  });

  it.each(['anthropic', 'openai', 'Claude'] as const)('rejects %s as an unsupported AI provider', (provider) => {
    expectRejected(RawConfig, { $schema: CONFIG_SCHEMA_URL, ai: { provider } });
  });

  it.each([1, 65_535])('accepts viewer port %d at the inclusive boundary', (port) => {
    expectAccepted(RawConfig, { $schema: CONFIG_SCHEMA_URL, viewer: { port } });
  });

  it.each([0, 65_536, 1.5])('rejects viewer port %d outside the integer range', (port) => {
    expectRejected(RawConfig, { $schema: CONFIG_SCHEMA_URL, viewer: { port } });
  });
});
