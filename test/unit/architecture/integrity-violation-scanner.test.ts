import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { scanIntegrityViolationInventory } from '../../../tools/integrity-violation-scanner.js';

const integritySource = 'export class IntegrityViolationError extends Error {}';
const runSource = 'export function isRepairableNavigationFailure(_error: unknown): boolean { return false; }';

type Inventory = ReturnType<typeof scanIntegrityViolationInventory>;

async function withProgram(
  files: Readonly<Record<string, string>>,
  assertion: (program: ts.Program, names: Readonly<Record<string, string>>) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-integrity-violation-scanner-'));
  const names = Object.fromEntries(Object.keys(files).map((path) => [path, join(root, path)]));
  try {
    await Promise.all(Object.entries(files).map(async ([path, text]) => {
      const fileName = names[path];
      if (fileName === undefined) throw new Error(`Missing synthetic name for ${path}.`);
      await mkdir(dirname(fileName), { recursive: true });
      await writeFile(fileName, text);
    }));
    const program = ts.createProgram({
      rootNames: Object.values(names),
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
    assertion(program, names);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

async function withCaller(
  source: string,
  assertion: (inventory: Inventory, names: Readonly<Record<string, string>>) => void,
): Promise<void> {
  await withProgram({
    'src/core/errors/integrity-violation-error.ts': integritySource,
    'src/usecases/run.ts': runSource,
    'src/usecases/caller.ts': source,
  }, (program, names) => {
    const integrity = names['src/core/errors/integrity-violation-error.ts'];
    const run = names['src/usecases/run.ts'];
    if (integrity === undefined || run === undefined) throw new Error('Synthetic integrity modules are missing.');
    assertion(scanIntegrityViolationInventory(program, integrity, run), names);
  });
}

describe('scanIntegrityViolationInventory()', () => {
  test('projects an exact direct repairable-navigation call into the allowlist only', async () => {
    await withCaller([
      "import { isRepairableNavigationFailure } from './run.js';",
      'function direct(): boolean { return isRepairableNavigationFailure(undefined); }',
      'void direct;',
    ].join('\n'), (inventory, names) => {
      expect(inventory.allowlistCallSites).toEqual([{
        fileName: names['src/usecases/caller.ts'],
        functionName: 'direct',
      }]);
      expect(inventory.unsafeReferences).toEqual([]);
    });
  });

  test('keeps destructuring aliases and indirect call/apply forms out of the allowlist with one unsafe entry per form', async () => {
    await withCaller([
      "import * as run from './run.js';",
      'function viaDestructuring(): void { const { isRepairableNavigationFailure: alias } = run; void alias; }',
      'function viaCall(): void { run.isRepairableNavigationFailure.call(undefined, undefined); }',
      'function viaApply(): void { run.isRepairableNavigationFailure.apply(undefined, [undefined]); }',
    ].join('\n'), (inventory, names) => {
      expect(inventory.allowlistCallSites).toEqual([]);
      expect(inventory.unsafeReferences).toEqual([
        { fileName: names['src/usecases/caller.ts'], functionName: 'viaDestructuring' },
        { fileName: names['src/usecases/caller.ts'], functionName: 'viaCall' },
        { fileName: names['src/usecases/caller.ts'], functionName: 'viaApply' },
      ]);
    });
  });
});
