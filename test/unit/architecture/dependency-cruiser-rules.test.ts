import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import { describe, expect, test } from 'vitest';
// @ts-expect-error -- the docs-first ESM config intentionally has no .d.ts file.
import dependencyCruiserConfig from '../../../.dependency-cruiser.mjs';

const FIXTURE_ROOT = fileURLToPath(
  new URL('../../fixtures/architecture/dependency-cruiser/', import.meta.url),
);
const REPOSITORY_TSCONFIG = resolve('tsconfig.json');

interface EdgeCase {
  readonly id: string;
  readonly expectedRuleId: string;
  readonly source: string;
  readonly target: string | RegExp;
  readonly compliantSource: string;
  readonly compliantTarget: string;
}

function expectedCompliantDependency(target: string) {
  return target.startsWith('src/')
    ? { resolved: target }
    : { module: target };
}

function expectedViolationTarget(target: string | RegExp) {
  return typeof target === 'string' ? target : expect.stringMatching(target);
}

const edgeCases: readonly EdgeCase[] = [
  {
    id: 'core-boundary',
    expectedRuleId: 'core-is-leaf',
    source: 'src/core/synthetic-core.ts',
    target: 'src/adapters/synthetic-adapter.ts',
    compliantSource: 'src/core/synthetic-core.ts',
    compliantTarget: 'src/core/synthetic-token.ts',
  },
  {
    id: 'core-external',
    expectedRuleId: 'core-external-allowlist',
    source: 'src/core/synthetic-core.ts',
    target: 'fs',
    compliantSource: 'src/core/synthetic-core.ts',
    compliantTarget: 'zod',
  },
  {
    id: 'core-external-crypto',
    expectedRuleId: 'core-external-allowlist',
    source: 'src/core/synthetic-core.ts',
    target: 'fs',
    compliantSource: 'src/core/synthetic-core.ts',
    compliantTarget: 'crypto',
  },
  {
    id: 'core-external-buffer',
    expectedRuleId: 'core-external-allowlist',
    source: 'src/core/synthetic-core.ts',
    target: 'fs',
    compliantSource: 'src/core/synthetic-core.ts',
    compliantTarget: 'buffer',
  },
  {
    id: 'core-external-default-deny',
    expectedRuleId: 'core-external-allowlist',
    source: 'src/core/synthetic-core.ts',
    target: 'left-pad',
    compliantSource: 'src/core/synthetic-core.ts',
    compliantTarget: 'zod',
  },
  {
    id: 'core-external-resolved-default-deny',
    expectedRuleId: 'core-external-allowlist',
    source: 'src/core/synthetic-core.ts',
    target: /node_modules\/ajv\//,
    compliantSource: 'src/core/synthetic-core.ts',
    compliantTarget: 'zod',
  },
  {
    id: 'core-external-fake-builtin',
    expectedRuleId: 'core-external-allowlist',
    source: 'src/core/synthetic-core.ts',
    target: 'crypto/fake',
    compliantSource: 'src/core/synthetic-core.ts',
    compliantTarget: 'crypto',
  },
  {
    id: 'usecases-adapters-value',
    expectedRuleId: 'usecases-no-concrete-adapters',
    source: 'src/usecases/synthetic-usecase.ts',
    target: 'src/adapters/synthetic-adapter.ts',
    compliantSource: 'src/usecases/synthetic-usecase.ts',
    compliantTarget: 'src/core/synthetic-token.ts',
  },
  {
    id: 'usecases-adapters-type',
    expectedRuleId: 'usecases-no-concrete-adapters',
    source: 'src/usecases/synthetic-usecase.ts',
    target: 'src/adapters/synthetic-adapter.ts',
    compliantSource: 'src/usecases/synthetic-usecase.ts',
    compliantTarget: 'src/report/synthetic-report.ts',
  },
  {
    id: 'usecases-ports',
    expectedRuleId: 'usecases-ports-types-only',
    source: 'src/usecases/synthetic-usecase.ts',
    target: 'src/ports/synthetic-port.ts',
    compliantSource: 'src/usecases/synthetic-usecase.ts',
    compliantTarget: 'src/ports/synthetic-port.ts',
  },
  {
    id: 'ports-core',
    expectedRuleId: 'ports-core-types-only',
    source: 'src/ports/synthetic-port.ts',
    target: 'src/core/synthetic-core.ts',
    compliantSource: 'src/ports/synthetic-port.ts',
    compliantTarget: 'src/core/synthetic-core.ts',
  },
  {
    id: 'report-core',
    expectedRuleId: 'report-core-types-only',
    source: 'src/report/synthetic-report.ts',
    target: 'src/core/synthetic-core.ts',
    compliantSource: 'src/report/synthetic-report.ts',
    compliantTarget: 'src/core/synthetic-core.ts',
  },
  {
    id: 'config-ports',
    expectedRuleId: 'config-ports-types-only',
    source: 'src/config/synthetic-config.ts',
    target: 'src/ports/synthetic-port.ts',
    compliantSource: 'src/config/synthetic-config.ts',
    compliantTarget: 'src/ports/synthetic-port.ts',
  },
  {
    id: 'cli-runtime',
    expectedRuleId: 'cli-must-go-through-runtime',
    source: 'src/cli/synthetic-cli.ts',
    target: 'src/core/synthetic-core.ts',
    compliantSource: 'src/cli/synthetic-cli.ts',
    compliantTarget: 'src/runtime/synthetic-runtime.ts',
  },
  {
    id: 'adapters-http-runtime',
    expectedRuleId: 'adapters-http-runtime-only',
    source: 'src/runtime/synthetic-runtime.ts',
    target: 'src/adapters/http/synthetic-http.ts',
    compliantSource: 'src/adapters/http/synthetic-http.ts',
    compliantTarget: 'src/runtime/synthetic-runtime.ts',
  },
  {
    id: 'adapters-storage-family',
    expectedRuleId: 'adapters-no-sibling-reachover',
    source: 'src/adapters/storage/synthetic-storage.ts',
    target: 'src/adapters/storage-extra/synthetic-storage-extra.ts',
    compliantSource: 'src/adapters/storage/synthetic-storage.ts',
    compliantTarget: 'src/adapters/storage/synthetic-driver.ts',
  },
  {
    id: 'adapters-storage-ai',
    expectedRuleId: 'adapters-no-sibling-reachover',
    source: 'src/adapters/storage/synthetic-storage.ts',
    target: 'src/adapters/ai/synthetic-ai.ts',
    compliantSource: 'src/adapters/storage/synthetic-storage.ts',
    compliantTarget: 'src/adapters/storage/synthetic-driver.ts',
  },
  {
    id: 'adapters-storage-ports',
    expectedRuleId: 'adapters-no-sibling-reachover',
    source: 'src/adapters/storage/synthetic-storage.ts',
    target: 'src/ports/ai.ts',
    compliantSource: 'src/adapters/storage/synthetic-storage.ts',
    compliantTarget: 'src/ports/storage.ts',
  },
  {
    id: 'ports-runtime',
    expectedRuleId: 'ports-boundary',
    source: 'src/ports/synthetic-port.ts',
    target: 'src/runtime/synthetic-runtime.ts',
    compliantSource: 'src/ports/synthetic-port.ts',
    compliantTarget: 'src/ports/synthetic-sibling.ts',
  },
  {
    id: 'usecases-config',
    expectedRuleId: 'usecases-boundary',
    source: 'src/usecases/synthetic-usecase.ts',
    target: 'src/config/synthetic-config.ts',
    compliantSource: 'src/usecases/synthetic-usecase.ts',
    compliantTarget: 'src/report/synthetic-report.ts',
  },
  {
    id: 'report-adapters',
    expectedRuleId: 'report-boundary',
    source: 'src/report/synthetic-report.ts',
    target: 'src/adapters/storage/synthetic-storage.ts',
    compliantSource: 'src/report/synthetic-report.ts',
    compliantTarget: 'src/report/synthetic-sibling.ts',
  },
  {
    id: 'build-tools-runtime',
    expectedRuleId: 'build-tools-boundary',
    source: 'src/build-tools/synthetic-build-tool.ts',
    target: 'src/runtime/synthetic-runtime.ts',
    compliantSource: 'src/build-tools/synthetic-build-tool.ts',
    compliantTarget: 'src/core/synthetic-core.ts',
  },
  {
    id: 'build-tools-external',
    expectedRuleId: 'build-tools-external-allowlist',
    source: 'src/build-tools/synthetic-build-tool.ts',
    target: 'crypto',
    compliantSource: 'src/build-tools/synthetic-build-tool.ts',
    compliantTarget: 'fs/promises',
  },
];

function fixturePath(id: string, variant: 'violation' | 'compliant'): string {
  return join(FIXTURE_ROOT, id, variant);
}

async function cruiseFixture(root: string, entry = 'src'): Promise<ICruiseResult> {
  const report = await cruise([entry], {
    ...dependencyCruiserConfig.options,
    baseDir: root,
    enhancedResolveOptions: { modules: [resolve('node_modules')] },
    ruleSet: { forbidden: dependencyCruiserConfig.forbidden },
    tsPreCompilationDeps: 'specify',
    tsConfig: { fileName: 'tsconfig.json' },
    validate: true,
    outputType: 'json',
  });

  if (typeof report.output !== 'string') {
    throw new TypeError('dependency-cruiser JSON reporter returned a non-string result');
  }

  const result = JSON.parse(report.output) as ICruiseResult;

  expect(result.summary).toMatchObject({
    info: 0,
    warn: 0,
  });

  return result;
}

describe('dependency-cruiser architecture rules', () => {
  test('generates one internal boundary for every policy role', () => {
    expect(dependencyCruiserConfig.forbidden.map((rule: { readonly name: string }) => rule.name)).toEqual(expect.arrayContaining([
      'core-is-leaf',
      'ports-boundary',
      'adapters-no-sibling-reachover',
      'adapters-http-boundary',
      'usecases-boundary',
      'report-boundary',
      'config-boundary',
      'runtime-boundary',
      'cli-must-go-through-runtime',
      'public-entry-boundary',
      'build-tools-boundary',
      'global-types-boundary',
    ]));
  });

  test('configures pre-compilation dependency data for types-only rules', () => {
    expect(dependencyCruiserConfig.options).toMatchObject({
      tsPreCompilationDeps: 'specify',
      tsConfig: { fileName: 'tsconfig.json' },
    });
    expect(existsSync(REPOSITORY_TSCONFIG)).toBe(true);
  });

  test.each(edgeCases)('$id rejects the exact forbidden edge', async ({
    expectedRuleId,
    id,
    source,
    target,
  }) => {
    const result = await cruiseFixture(fixturePath(id, 'violation'));

    expect(result.summary.violations).toEqual([
      expect.objectContaining({
        from: source,
        rule: expect.objectContaining({ name: expectedRuleId }),
        to: expectedViolationTarget(target),
      }),
    ]);
  });

  test.each(edgeCases)('$id permits its expected compliant edge', async ({
    compliantSource,
    compliantTarget,
    id,
  }) => {
    const result = await cruiseFixture(fixturePath(id, 'compliant'));

    expect(result.summary.violations).toEqual([]);
    expect(result.modules).toContainEqual(expect.objectContaining({
      dependencies: expect.arrayContaining([
        expect.objectContaining(expectedCompliantDependency(compliantTarget)),
      ]),
      source: compliantSource,
    }));
  });

  test('uses resolution facts for core external decisions', async () => {
    const allowed = await cruiseFixture(fixturePath('core-external-default-deny', 'compliant'));
    const rejected = await cruiseFixture(fixturePath('core-external-resolved-default-deny', 'violation'));
    const fakeBuiltin = await cruiseFixture(fixturePath('core-external-fake-builtin', 'violation'));

    const allowedDependency = allowed.modules
      .find(({ source }) => source === 'src/core/synthetic-core.ts')
      ?.dependencies.find(({ module }) => module === 'zod');
    const rejectedDependency = rejected.modules
      .find(({ source }) => source === 'src/core/synthetic-core.ts')
      ?.dependencies.find(({ module }) => module === 'ajv');
    const fakeBuiltinDependency = fakeBuiltin.modules
      .find(({ source }) => source === 'src/core/synthetic-core.ts')
      ?.dependencies.find(({ module }) => module === 'crypto/fake');

    expect(allowedDependency).toMatchObject({
      couldNotResolve: false,
      dependencyTypes: expect.arrayContaining(['npm']),
      resolved: expect.stringContaining('node_modules/zod/'),
    });
    expect(rejectedDependency).toMatchObject({
      couldNotResolve: false,
      dependencyTypes: expect.arrayContaining(['npm-dev']),
      resolved: expect.stringContaining('node_modules/ajv/'),
    });
    expect(fakeBuiltinDependency).toMatchObject({
      couldNotResolve: true,
      dependencyTypes: ['unknown'],
    });
  });

  test('cruises a declared but file-less ports layer without violations or environment issues', async () => {
    const result = await cruiseFixture(join(FIXTURE_ROOT, 'empty-layer'), 'src/ports');

    expect(result.modules).toEqual([]);
    expect(result.summary).toMatchObject({
      totalCruised: 0,
      totalDependenciesCruised: 0,
      violations: [],
    });
  });
});
