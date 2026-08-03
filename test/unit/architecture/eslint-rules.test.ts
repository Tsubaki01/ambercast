import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Linter, type Linter as LinterTypes } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, test } from 'vitest';
// @ts-expect-error -- the docs-first flat config intentionally has no .d.ts file.
import eslintConfig from '../../../eslint.config.js';

const RESTRICTED_SYNTAX_RULE = 'no-restricted-syntax';
const BOUNDARIES_ELEMENT_TYPES_RULE = 'boundaries/element-types';
const flatEslintConfig = eslintConfig as LinterTypes.FlatConfig[];
const DEPENDENCY_CRUISER_FIXTURE_ROOT = new URL(
  '../../fixtures/architecture/dependency-cruiser/',
  import.meta.url,
);

interface BoundariesFixtureCase {
  readonly id: string;
  readonly source: string;
  readonly expectedMessage: string;
}

function restrictedSyntaxMessages(code: string, filename: string) {
  const messages = new Linter({ configType: 'flat' }).verify(code, flatEslintConfig, filename);

  expect(messages.filter(({ fatal }) => fatal)).toEqual([]);

  return messages.filter(({ ruleId }) => ruleId === RESTRICTED_SYNTAX_RULE);
}

/**
 * ESLint's bundled Node resolver follows physical files, while the TypeScript
 * fixtures deliberately use NodeNext's emitted-JavaScript import suffixes.
 * Projecting only those suffixes to their adjacent source files lets this
 * in-memory rule test inspect the same source-to-target fixture edges without
 * changing the fixture corpus or requiring a second resolver package.
 */
function projectNodeNextFixtureImportsToTypeScript(code: string): string {
  return code.replaceAll(/(from\s+['"][^'"]+)\.js(['"])/g, '$1.ts$2');
}

function boundaryRuleConfiguration(fixtureRoot: string): LinterTypes.FlatConfig[] {
  const settings = Object.assign({}, ...flatEslintConfig.map((config) => config.settings));
  const plugins = Object.assign({}, ...flatEslintConfig.map((config) => config.plugins));
  const configuredRule = flatEslintConfig
    .map((config) => config.rules?.[BOUNDARIES_ELEMENT_TYPES_RULE])
    .find((rule) => rule !== undefined);

  return [
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
    },
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
      plugins,
      rules: configuredRule === undefined
        ? {}
        : { [BOUNDARIES_ELEMENT_TYPES_RULE]: configuredRule },
      settings: {
        ...settings,
        'boundaries/root-path': fixtureRoot,
      },
    },
  ];
}

async function boundariesMessagesForFixture(
  id: string,
  variant: 'violation' | 'compliant',
  source: string,
): Promise<{ fileName: string; messages: LinterTypes.LintMessage[] }> {
  const fixtureRoot = new URL(`${id}/${variant}/`, DEPENDENCY_CRUISER_FIXTURE_ROOT);
  const fileName = join(fixtureRoot.pathname, source);
  const code = projectNodeNextFixtureImportsToTypeScript(await readFile(fileName, 'utf8'));
  const messages = new Linter({ configType: 'flat' }).verify(
    code,
    boundaryRuleConfiguration(fixtureRoot.pathname),
    fileName,
  );

  expect(messages.filter(({ fatal }) => fatal)).toEqual([]);

  return {
    fileName,
    messages: messages.filter(({ ruleId }) => ruleId === BOUNDARIES_ELEMENT_TYPES_RULE),
  };
}

const nondeterministicGlobalCases = [
  ['Date.now()', 'Date.now();'],
  ['new Date()', 'new Date();'],
  ['Math.random()', 'Math.random();'],
  ['crypto.randomUUID()', 'crypto.randomUUID();'],
  ['process.env', 'process.env.AMBERCAST_MODE;'],
  ['process["env"]', 'process["env"].AMBERCAST_MODE;'],
] as const;

const boundariesFixtureCases: readonly BoundariesFixtureCase[] = [
  {
    id: 'core-boundary',
    source: 'src/core/synthetic-core.ts',
    expectedMessage: 'There is no policy allowing dependencies from elements of type "core" to elements of type "adapters"',
  },
  {
    id: 'usecases-ports',
    source: 'src/usecases/synthetic-usecase.ts',
    expectedMessage: 'There is no policy allowing dependencies from elements of type "usecases" to elements of type "ports"',
  },
  {
    id: 'cli-runtime',
    source: 'src/cli/synthetic-cli.ts',
    expectedMessage: 'There is no policy allowing dependencies from elements of type "cli" to elements of type "core"',
  },
  {
    id: 'adapters-http-runtime',
    source: 'src/runtime/synthetic-runtime.ts',
    expectedMessage: 'There is no policy allowing dependencies from elements of type "runtime" to elements of type "adapters-http"',
  },
  {
    id: 'adapters-storage-family',
    source: 'src/adapters/storage/synthetic-storage.ts',
    expectedMessage: 'There is no policy allowing dependencies from elements of type "adapters" and captured values: family="storage" to elements of type "adapters" and captured values: family="storage-extra"',
  },
];

describe('ESLint architecture and determinism rules', () => {
  test.each(nondeterministicGlobalCases)(
    'rejects %s outside the system adapter',
    (_name, code) => {
      expect(restrictedSyntaxMessages(code, 'src/core/synthetic.ts')).toHaveLength(1);
    },
  );

  test.each(nondeterministicGlobalCases)(
    'permits %s inside the system adapter',
    (_name, code) => {
      expect(restrictedSyntaxMessages(code, 'src/adapters/system/synthetic.ts')).toEqual([]);
    },
  );

  test.each(nondeterministicGlobalCases)(
    'rejects %s in the same-prefix system-extra adapter',
    (_name, code) => {
      expect(restrictedSyntaxMessages(code, 'src/adapters/system-extra/synthetic.ts')).toHaveLength(1);
    },
  );

  test.each([
    ['Date', 'const Date = { now: () => 0 }; Date.now();'],
    ['Math', 'const Math = { random: () => 0 }; Math.random();'],
    ['crypto', 'const crypto = { randomUUID: () => "id" }; crypto.randomUUID();'],
    ['process', 'const process = { env: { MODE: "test" } }; process.env.MODE;'],
  ])('reports the documented syntax-only false positive for shadowed %s', (_name, code) => {
    expect(restrictedSyntaxMessages(code, 'src/core/synthetic.ts')).toHaveLength(1);
  });

  test.each(['src/core/synthetic.ts', 'src/adapters/system/synthetic.ts'])(
    'always permits new Date(value) in %s',
    (filename) => {
      expect(restrictedSyntaxMessages('new Date(0);', filename)).toEqual([]);
    },
  );

  test('does not overmatch a neighboring API call', () => {
    expect(restrictedSyntaxMessages('Date.parse("2026-08-03");', 'src/core/synthetic.ts')).toEqual([]);
  });

  test('permits computeInputsDigest with a clean inline literal', () => {
    const code = [
      'function computeInputsDigest(input) { return input; }',
      'computeInputsDigest({ schemaVersion: 1 });',
    ].join('\n');

    expect(restrictedSyntaxMessages(code, 'src/core/synthetic.ts')).toEqual([]);
  });

  test.each([
    [
      'a bare identifier',
      [
        'function computeInputsDigest(input) { return input; }',
        'const inputs = { schemaVersion: 1 };',
        'computeInputsDigest(inputs);',
      ].join('\n'),
    ],
    [
      'member access',
      [
        'function computeInputsDigest(input) { return input; }',
        'const source = { inputs: { schemaVersion: 1 } };',
        'computeInputsDigest(source.inputs);',
      ].join('\n'),
    ],
    [
      'a spread of an identifier',
      [
        'function computeInputsDigest(input) { return input; }',
        'const wider = { schemaVersion: 1 };',
        'computeInputsDigest({ ...wider });',
      ].join('\n'),
    ],
    [
      'a spread of another literal',
      [
        'function computeInputsDigest(input) { return input; }',
        'computeInputsDigest({ ...{ schemaVersion: 1 } });',
      ].join('\n'),
    ],
    [
      'an unrelated same-named local function with a bare identifier',
      [
        'function computeInputsDigest(input) { return input; }',
        'const inputs = { schemaVersion: 1 };',
        'computeInputsDigest(inputs);',
      ].join('\n'),
    ],
  ])('rejects digest input expressed as %s', (_name, code) => {
    expect(restrictedSyntaxMessages(code, 'src/core/synthetic.ts')).toHaveLength(1);
  });

  test.each(boundariesFixtureCases)(
    '$id reports the exact boundaries violation from its fixture source',
    async ({ expectedMessage, id, source }) => {
      const result = await boundariesMessagesForFixture(id, 'violation', source);

      expect(result.messages).toEqual([
        expect.objectContaining({
          message: expectedMessage,
          ruleId: BOUNDARIES_ELEMENT_TYPES_RULE,
        }),
      ]);
    },
  );

  test.each(boundariesFixtureCases)(
    '$id permits the compliant fixture edge through boundaries/element-types',
    async ({ id, source }) => {
      const result = await boundariesMessagesForFixture(id, 'compliant', source);

      expect(result.messages).toEqual([]);
    },
  );
});
