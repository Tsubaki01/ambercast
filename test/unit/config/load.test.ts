import { describe, expect, it } from 'vitest';
import type { ConfigEnvSnapshot, ResolvedConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { DEFAULT_RAW_CONFIG } from '#config/defaults.js';
import { loadConfig } from '#config/load.js';
import type { StorageAdapter } from '#ports/storage.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';

const CONFIG_SCHEMA_URL = 'https://ambercast.dev/schema/config.json';
const CWD = '/workspace/project/apps/client';
const ANCESTOR_CONFIG_PATH = '/workspace/project/ambercast.config.json';
const COMMAND_CONFIG_PATH = `${CWD}/settings/command.json`;
const ENVIRONMENT_CONFIG_PATH = `${CWD}/settings/environment.json`;
const ABSOLUTE_COMMAND_CONFIG_PATH = '/workspace/explicit/command.json';
const ABSOLUTE_ENVIRONMENT_CONFIG_PATH = '/workspace/explicit/environment.json';
const APP_TARGET = { baseUrl: 'http://app.test', browser: 'chromium' } as const;
const ADMIN_TARGET = { baseUrl: 'http://admin.test', browser: 'chromium' } as const;

interface LoadOptions {
  readonly cwd?: string | undefined;
  readonly configPathOverride?: string | undefined;
  readonly configEnv?: ConfigEnvSnapshot | undefined;
}

function expectedDefaults(configRoot: string): ResolvedConfig {
  return {
    testDir: `${configRoot}/tests/ambercast`,
    runsDir: `${configRoot}/tests/ambercast/.runs`,
    testMatch: ['**/*.test.md'],
    testIgnore: ['**/.runs/**', '**/*.ambercast.plan.json', '**/*.ambercast.grounding.json'],
    targets: {
      'web-user': {
        baseUrl: 'http://localhost:3000',
        browser: 'chromium',
      },
    },
    defaultTarget: 'web-user',
    ai: {
      provider: 'auto',
    },
    viewer: {
      port: 4_600,
    },
    ci: {
      heal: false,
      updateGroundingCache: false,
    },
  };
}

function withoutDefaultTarget(config: ResolvedConfig): Omit<ResolvedConfig, 'defaultTarget'> {
  const { defaultTarget: _defaultTarget, ...configWithoutDefaultTarget } = config;
  return configWithoutDefaultTarget;
}

function containsIssuePath(value: unknown, expectedPath: readonly string[]): boolean {
  if (Array.isArray(value)) {
    const isExpectedPath = value.length === expectedPath.length
      && value.every((segment, index) => segment === expectedPath[index]);

    return isExpectedPath || value.some((member) => containsIssuePath(member, expectedPath));
  }

  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((member) => containsIssuePath(member, expectedPath));
  }

  return false;
}

async function writeConfig(storage: StorageAdapter, path: string, content: Record<string, unknown>): Promise<void> {
  await storage.writeText(path, JSON.stringify({ $schema: CONFIG_SCHEMA_URL, ...content }));
}

async function load(storage: StorageAdapter, options: LoadOptions = {}): Promise<ResolvedConfig> {
  return loadConfig({
    cwd: options.cwd ?? CWD,
    storage,
    ...(options.configPathOverride === undefined ? {} : { configPathOverride: options.configPathOverride }),
    ...(options.configEnv === undefined ? {} : { configEnv: options.configEnv }),
  });
}

async function expectConfigInvalid(operation: Promise<unknown>): Promise<ConfigInvalidError> {
  let thrown: unknown;

  try {
    await operation;
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(ConfigInvalidError);

  if (!(thrown instanceof ConfigInvalidError)) {
    throw new Error('Expected a ConfigInvalidError.');
  }

  expect(thrown.kind).toBe('config-invalid');
  expect(thrown.exitCode).toBe(2);
  return thrown;
}

async function createDiscoveryConflictFixture(): Promise<StorageAdapter> {
  const storage = createInMemoryStorage();

  await writeConfig(storage, ANCESTOR_CONFIG_PATH, { viewer: { port: 4_601 } });
  await writeConfig(storage, COMMAND_CONFIG_PATH, { viewer: { port: 4_602 } });
  await writeConfig(storage, ENVIRONMENT_CONFIG_PATH, { viewer: { port: 4_603 } });
  await writeConfig(storage, ABSOLUTE_COMMAND_CONFIG_PATH, { viewer: { port: 4_604 } });
  await writeConfig(storage, ABSOLUTE_ENVIRONMENT_CONFIG_PATH, { viewer: { port: 4_605 } });
  return storage;
}

describe('loadConfig', () => {
  describe('configuration selection', () => {
    it.each([
      [
        'a relative command override ahead of the environment override and ancestor file',
        'settings/command.json',
        { configPathOverride: 'settings/environment.json' },
        `${CWD}/settings`,
        4_602,
      ],
      [
        'an absolute command override ahead of the environment override and ancestor file',
        ABSOLUTE_COMMAND_CONFIG_PATH,
        { configPathOverride: ABSOLUTE_ENVIRONMENT_CONFIG_PATH },
        '/workspace/explicit',
        4_604,
      ],
      [
        'the environment override when the command override is an empty string',
        '',
        { configPathOverride: 'settings/environment.json' },
        `${CWD}/settings`,
        4_603,
      ],
      [
        'a relative environment override ahead of an ancestor file',
        undefined,
        { configPathOverride: 'settings/environment.json' },
        `${CWD}/settings`,
        4_603,
      ],
      [
        'an absolute environment override ahead of an ancestor file',
        undefined,
        { configPathOverride: ABSOLUTE_ENVIRONMENT_CONFIG_PATH },
        '/workspace/explicit',
        4_605,
      ],
      [
        'the nearest ancestor file when the environment override is an empty string',
        undefined,
        { configPathOverride: '' },
        '/workspace/project',
        4_601,
      ],
      [
        'the nearest ancestor file when neither explicit source is supplied',
        undefined,
        undefined,
        '/workspace/project',
        4_601,
      ],
    ] as const)(
      'selects %s',
      async (_description, configPathOverride, configEnv, expectedRoot, expectedViewerPort) => {
        const config = await load(await createDiscoveryConflictFixture(), { configPathOverride, configEnv });

        expect(config).toStrictEqual({
          ...expectedDefaults(expectedRoot),
          viewer: { port: expectedViewerPort },
        });
      },
    );

    it.each([
      ['a command override', { configPathOverride: '/workspace/missing-command.json' }],
      ['an environment override', { configEnv: { configPathOverride: '/workspace/missing-environment.json' } }],
    ] as const)('treats a missing %s as terminal instead of falling through', async (_source, options) => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, ANCESTOR_CONFIG_PATH, { viewer: { port: 4_601 } });

      await expectConfigInvalid(load(storage, options));
    });

    it('selects the nearest ambercast.config.json and ignores another marker while walking ancestors', async () => {
      const storage = createInMemoryStorage();
      await storage.writeText('/workspace/project/package.json', '{"name":"project"}');
      await writeConfig(storage, '/workspace/ambercast.config.json', { viewer: { port: 4_606 } });
      await writeConfig(storage, ANCESTOR_CONFIG_PATH, { viewer: { port: 4_607 } });

      const config = await load(storage);

      expect(config).toStrictEqual({
        ...expectedDefaults('/workspace/project'),
        viewer: { port: 4_607 },
      });
    });

    it('reaches the filesystem root and uses defaults when no configuration file exists', async () => {
      const config = await load(createInMemoryStorage(), { cwd: '/' });

      expect(config).toStrictEqual(expectedDefaults(''));
    });

    it.each([
      ['a command override with a dot segment', { configPathOverride: './ambercast.config.json' }],
      ['a command override with a repeated separator', { configPathOverride: 'settings//ambercast.config.json' }],
      ['an environment override with a dot segment', { configEnv: { configPathOverride: './ambercast.config.json' } }],
      ['an environment override with a repeated separator', { configEnv: { configPathOverride: 'settings//ambercast.config.json' } }],
    ] as const)('classifies %s as invalid configuration rather than leaking RangeError', async (_description, options) => {
      await expectConfigInvalid(load(createInMemoryStorage(), options));
    });
  });

  describe('parsing and validation failures', () => {
    it('wraps malformed JSON in ConfigInvalidError while retaining the SyntaxError cause', async () => {
      const storage = createInMemoryStorage();
      await storage.writeText(`${CWD}/ambercast.config.json`, '{"$schema":');

      const error = await expectConfigInvalid(load(storage));

      expect(error.cause).toBeInstanceOf(SyntaxError);
    });

    it('retains the failing Zod issue path for schema-invalid content', async () => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, `${CWD}/ambercast.config.json`, { viewer: { port: 0 } });

      const error = await expectConfigInvalid(load(storage));

      expect(error.message).toContain('viewer.port');
      expect(error.details).toBeDefined();
      expect(containsIssuePath(error.details, ['viewer', 'port'])).toBe(true);
    });

    it.each([
      ['__proto__', `{"$schema":"${CONFIG_SCHEMA_URL}","__proto__":{}}`],
      ['constructor', `{"$schema":"${CONFIG_SCHEMA_URL}","constructor":{}}`],
    ] as const)('rejects a raw JSON %s key before any merge can use it', async (_key, rawDocument) => {
      const storage = createInMemoryStorage();
      await storage.writeText(`${CWD}/ambercast.config.json`, rawDocument);

      await expectConfigInvalid(load(storage));
    });

    it.each([
      ['testDir', { testDir: './checks' }],
      ['runsDir', { runsDir: 'artifacts//runs' }],
    ] as const)('rejects a resolved %s with non-normalized POSIX path syntax', async (_field, rawConfig) => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, `${CWD}/ambercast.config.json`, rawConfig);

      await expectConfigInvalid(load(storage));
    });
  });

  describe('merging and target validation', () => {
    it('replaces targets atomically and clears the built-in default target when the file omits it', async () => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, `${CWD}/ambercast.config.json`, {
        targets: { app: APP_TARGET, admin: ADMIN_TARGET },
      });

      const config = await load(storage);

      expect(config).toStrictEqual({
        ...withoutDefaultTarget(expectedDefaults(CWD)),
        targets: { app: APP_TARGET, admin: ADMIN_TARGET },
      });
    });

    it('uses a supplied default target only when it names a supplied replacement target', async () => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, `${CWD}/ambercast.config.json`, {
        targets: { app: APP_TARGET },
        defaultTarget: 'app',
      });

      const config = await load(storage);

      expect(config).toStrictEqual({
        ...expectedDefaults(CWD),
        targets: { app: APP_TARGET },
        defaultTarget: 'app',
      });
    });

    it.each([
      ['a defaultTarget that names no replacement target', { targets: { app: APP_TARGET }, defaultTarget: 'missing' }],
      ['an empty targets replacement', { targets: {} }],
    ] as const)('rejects %s', async (_description, rawConfig) => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, `${CWD}/ambercast.config.json`, rawConfig);

      await expectConfigInvalid(load(storage));
    });

    it('merges ai, viewer, and ci one level deep while replacing other supplied top-level values', async () => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, `${CWD}/ambercast.config.json`, {
        testMatch: ['specs/**/*.md'],
        testIgnore: [],
        ai: { provider: 'claude' },
        viewer: { port: 4_321 },
        ci: { heal: true },
      });

      const config = await load(storage);

      expect(config).toStrictEqual({
        ...expectedDefaults(CWD),
        testMatch: ['specs/**/*.md'],
        testIgnore: [],
        ai: { provider: 'claude' },
        viewer: { port: 4_321 },
        ci: { heal: true, updateGroundingCache: false },
      });
    });
  });

  describe('environment AI provider precedence', () => {
    it.each(['claude', 'codex', 'auto'] as const)('overrides the file AI provider with valid raw value %s', async (provider) => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, `${CWD}/ambercast.config.json`, { ai: { provider: 'codex' } });

      const config = await load(storage, { configEnv: { aiProviderRaw: provider } });

      expect(config).toStrictEqual({
        ...expectedDefaults(CWD),
        ai: { provider },
      });
    });

    it.each(['unsupported', ''] as const)('rejects an invalid raw AI provider %j', async (aiProviderRaw) => {
      await expectConfigInvalid(load(createInMemoryStorage(), { configEnv: { aiProviderRaw } }));
    });
  });

  describe('path anchoring and result isolation', () => {
    it.each([
      [
        'relative directories against the ancestor config file directory',
        { testDir: 'checks', runsDir: 'artifacts' },
        '/workspace/project/checks',
        '/workspace/project/artifacts',
      ],
      [
        'absolute directories without re-anchoring them to the ancestor config file directory',
        { testDir: '/shared/checks', runsDir: '/shared/artifacts' },
        '/shared/checks',
        '/shared/artifacts',
      ],
    ] as const)('resolves %s', async (_description, rawConfig, testDir, runsDir) => {
      const storage = createInMemoryStorage();
      await writeConfig(storage, ANCESTOR_CONFIG_PATH, rawConfig);

      const config = await load(storage);

      expect(config).toStrictEqual({
        ...expectedDefaults('/workspace/project'),
        testDir,
        runsDir,
      });
    });

    it('creates non-aliased arrays and nested objects for every result and the defaults template', async () => {
      const storage = createInMemoryStorage();
      const first = await load(storage);
      const second = await load(storage);
      const mutableFirst = first as unknown as {
        testMatch: string[];
        targets: Record<string, { baseUrl: string; browser: 'chromium' }>;
        ai: { provider: 'claude' | 'codex' | 'auto' };
      };

      mutableFirst.testMatch.push('mutated/**/*.test.md');
      mutableFirst.targets['web-user']!.baseUrl = 'http://mutated.test';
      mutableFirst.ai.provider = 'claude';

      expect(second).toStrictEqual(expectedDefaults(CWD));
      expect(DEFAULT_RAW_CONFIG).toStrictEqual({
        testDir: 'tests/ambercast',
        runsDir: 'tests/ambercast/.runs',
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**', '**/*.ambercast.plan.json', '**/*.ambercast.grounding.json'],
        targets: {
          'web-user': {
            baseUrl: 'http://localhost:3000',
            browser: 'chromium',
          },
        },
        defaultTarget: 'web-user',
        ai: { provider: 'auto' },
        viewer: { port: 4_600 },
        ci: { heal: false, updateGroundingCache: false },
      });
    });
  });
});
