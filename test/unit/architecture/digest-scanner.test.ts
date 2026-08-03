import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import {
  scanComputeInputsDigestCalls,
  type DigestCallSite,
} from '../../../tools/digest-scanner.js';

const DIGEST_MODULE_SOURCE = [
  'export interface DigestInputs { readonly schemaVersion: number; }',
  'export function computeInputsDigest(_inputs: DigestInputs): string {',
  "  return 'synthetic-digest';",
  '}',
].join('\n');

async function withSyntheticProgram(
  callerSource: string,
  assertion: (
    program: ts.Program,
    digestModuleFileName: string,
    callerFileName: string,
  ) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-digest-scanner-'));
  const digestModuleFileName = join(root, 'src/core/ir/digest.ts');
  const callerFileName = join(root, 'src/usecases/synthetic-usecase.ts');

  try {
    await Promise.all([
      mkdir(dirname(digestModuleFileName), { recursive: true }),
      mkdir(dirname(callerFileName), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(digestModuleFileName, DIGEST_MODULE_SOURCE),
      writeFile(callerFileName, callerSource),
    ]);

    const program = ts.createProgram({
      rootNames: [digestModuleFileName, callerFileName],
      options: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2023,
      },
    });

    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(program.getSemanticDiagnostics()).toEqual([]);

    assertion(program, digestModuleFileName, callerFileName);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function expectOneSaneCallSite(
  program: ts.Program,
  digestModuleFileName: string,
  callerFileName: string,
  violation: DigestCallSite['violation'],
): DigestCallSite {
  const calls = scanComputeInputsDigestCalls(program, digestModuleFileName);

  expect(calls).toHaveLength(1);

  const [call] = calls;

  if (!call) {
    throw new Error('Expected the digest scanner to return one call site.');
  }

  expect(call).toMatchObject({
    fileName: callerFileName,
    violation,
  });
  expect(call.line).toBeGreaterThan(0);
  expect(call.column).toBeGreaterThan(0);

  return call;
}

describe('scanComputeInputsDigestCalls()', () => {
  test('records a direct call with a clean inline literal as compliant', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest } from '../core/ir/digest.js';",
        'computeInputsDigest({ schemaVersion: 1 });',
      ].join('\n'),
      (program, digestModuleFileName, callerFileName) => {
        expectOneSaneCallSite(program, digestModuleFileName, callerFileName, undefined);
      },
    );
  });

  test('records a clean literal wrapped in an as-expression as compliant', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest, type DigestInputs } from '../core/ir/digest.js';",
        'computeInputsDigest(({ schemaVersion: 1 }) as DigestInputs);',
      ].join('\n'),
      (program, digestModuleFileName, callerFileName) => {
        expectOneSaneCallSite(program, digestModuleFileName, callerFileName, undefined);
      },
    );
  });

  test('records a clean literal wrapped in a satisfies-expression as compliant', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest, type DigestInputs } from '../core/ir/digest.js';",
        'computeInputsDigest(({ schemaVersion: 1 }) satisfies DigestInputs);',
      ].join('\n'),
      (program, digestModuleFileName, callerFileName) => {
        expectOneSaneCallSite(program, digestModuleFileName, callerFileName, undefined);
      },
    );
  });

  test('records a clean literal wrapped in redundant parentheses as compliant', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest } from '../core/ir/digest.js';",
        'computeInputsDigest((({ schemaVersion: 1 })));',
      ].join('\n'),
      (program, digestModuleFileName, callerFileName) => {
        expectOneSaneCallSite(program, digestModuleFileName, callerFileName, undefined);
      },
    );
  });

  test('rejects a spread hidden inside a type wrapper', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest, type DigestInputs } from '../core/ir/digest.js';",
        'const wider = { schemaVersion: 1 };',
        'computeInputsDigest(({ ...wider }) as DigestInputs);',
      ].join('\n'),
      (program, digestModuleFileName, callerFileName) => {
        expectOneSaneCallSite(
          program,
          digestModuleFileName,
          callerFileName,
          'argument-must-not-contain-spread',
        );
      },
    );
  });

  test('rejects a direct call with a bare identifier', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest } from '../core/ir/digest.js';",
        'const inputs = { schemaVersion: 1 };',
        'computeInputsDigest(inputs);',
      ].join('\n'),
      (program, digestModuleFileName) => {
        expect(scanComputeInputsDigestCalls(program, digestModuleFileName)).toEqual([
          expect.objectContaining({ violation: 'argument-must-be-inline-object-literal' }),
        ]);
      },
    );
  });

  test('rejects a direct call with a member-access argument', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest } from '../core/ir/digest.js';",
        'const source = { inputs: { schemaVersion: 1 } };',
        'computeInputsDigest(source.inputs);',
      ].join('\n'),
      (program, digestModuleFileName, callerFileName) => {
        expectOneSaneCallSite(
          program,
          digestModuleFileName,
          callerFileName,
          'argument-must-be-inline-object-literal',
        );
      },
    );
  });

  test('rejects a direct call with a spread', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest } from '../core/ir/digest.js';",
        'const wider = { schemaVersion: 1 };',
        'computeInputsDigest({ ...wider });',
      ].join('\n'),
      (program, digestModuleFileName) => {
        expect(scanComputeInputsDigestCalls(program, digestModuleFileName)).toEqual([
          expect.objectContaining({ violation: 'argument-must-not-contain-spread' }),
        ]);
      },
    );
  });

  test('rejects a direct call with a spread of another literal', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest } from '../core/ir/digest.js';",
        'computeInputsDigest({ ...{ schemaVersion: 1 } });',
      ].join('\n'),
      (program, digestModuleFileName) => {
        expect(scanComputeInputsDigestCalls(program, digestModuleFileName)).toEqual([
          expect.objectContaining({ violation: 'argument-must-not-contain-spread' }),
        ]);
      },
    );
  });

  test('rejects an aliased import call that ESLint cannot resolve', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest as digest } from '../core/ir/digest.js';",
        'const inputs = { schemaVersion: 1 };',
        'digest(inputs);',
      ].join('\n'),
      (program, digestModuleFileName) => {
        expect(scanComputeInputsDigestCalls(program, digestModuleFileName)).toEqual([
          expect.objectContaining({ violation: 'argument-must-be-inline-object-literal' }),
        ]);
      },
    );
  });

  test('records an aliased import call with a clean inline literal as compliant', async () => {
    await withSyntheticProgram(
      [
        "import { computeInputsDigest as digest } from '../core/ir/digest.js';",
        'digest({ schemaVersion: 1 });',
      ].join('\n'),
      (program, digestModuleFileName, callerFileName) => {
        expectOneSaneCallSite(program, digestModuleFileName, callerFileName, undefined);
      },
    );
  });

  test('rejects a namespace-qualified call', async () => {
    await withSyntheticProgram(
      [
        "import * as digest from '../core/ir/digest.js';",
        'const inputs = { schemaVersion: 1 };',
        'digest.computeInputsDigest(inputs);',
      ].join('\n'),
      (program, digestModuleFileName) => {
        expect(scanComputeInputsDigestCalls(program, digestModuleFileName)).toEqual([
          expect.objectContaining({ violation: 'argument-must-be-inline-object-literal' }),
        ]);
      },
    );
  });

  test('records a namespace-qualified call with a clean inline literal as compliant', async () => {
    await withSyntheticProgram(
      [
        "import * as digest from '../core/ir/digest.js';",
        'digest.computeInputsDigest({ schemaVersion: 1 });',
      ].join('\n'),
      (program, digestModuleFileName, callerFileName) => {
        expectOneSaneCallSite(program, digestModuleFileName, callerFileName, undefined);
      },
    );
  });

  test('passes an unrelated same-named local function', async () => {
    await withSyntheticProgram(
      [
        'function computeInputsDigest(input: { schemaVersion: number }): object { return input; }',
        'const inputs = { schemaVersion: 1 };',
        'computeInputsDigest(inputs);',
      ].join('\n'),
      (program, digestModuleFileName) => {
        expect(scanComputeInputsDigestCalls(program, digestModuleFileName)).toEqual([]);
      },
    );
  });
});
