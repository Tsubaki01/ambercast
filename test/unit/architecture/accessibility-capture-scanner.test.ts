import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import {
  scanAccessibilityCaptureFieldAccess,
  type AccessibilityCaptureFieldAccessSite,
} from '../../../tools/accessibility-capture-scanner.js';

const PORTS_MODULE_SOURCE = [
  'export type AccessibilityCapture = {',
  '  readonly rawYaml: string;',
  '  readonly tree: unknown;',
  '  readonly scalarValues: readonly string[];',
  '};',
].join('\n');

async function withSyntheticProgram(
  callerSource: string,
  assertion: (
    program: ts.Program,
    portsModuleFileName: string,
    callerFileName: string,
  ) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-accessibility-capture-scanner-'));
  const portsModuleFileName = join(root, 'src/ports/browser.ts');
  const callerFileName = join(root, 'src/usecases/synthetic-usecase.ts');

  try {
    await Promise.all([
      mkdir(dirname(portsModuleFileName), { recursive: true }),
      mkdir(dirname(callerFileName), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(portsModuleFileName, PORTS_MODULE_SOURCE),
      writeFile(callerFileName, callerSource),
    ]);

    const program = ts.createProgram({
      rootNames: [portsModuleFileName, callerFileName],
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

    assertion(program, portsModuleFileName, callerFileName);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function expectOneSaneAccessSite(
  program: ts.Program,
  portsModuleFileName: string,
  callerFileName: string,
  expected: Pick<AccessibilityCaptureFieldAccessSite, 'field' | 'allowed'>,
): AccessibilityCaptureFieldAccessSite {
  const sites = scanAccessibilityCaptureFieldAccess(program, portsModuleFileName, new Set());

  expect(sites).toHaveLength(1);

  const [site] = sites;
  if (site === undefined) {
    throw new Error('Expected the accessibility-capture scanner to return one access site.');
  }

  expect(site).toMatchObject({ fileName: callerFileName, ...expected });
  expect(site.line).toBeGreaterThan(0);
  expect(site.column).toBeGreaterThan(0);

  return site;
}

describe('scanAccessibilityCaptureFieldAccess()', () => {
  test('flags a disallowed direct rawYaml property access', async () => {
    await withSyntheticProgram(
      [
        "import type { AccessibilityCapture } from '../ports/browser.js';",
        'declare const capture: AccessibilityCapture;',
        'void capture.rawYaml;',
      ].join('\n'),
      (program, portsModuleFileName, callerFileName) => {
        expectOneSaneAccessSite(program, portsModuleFileName, callerFileName, {
          field: 'rawYaml',
          allowed: false,
        });
      },
    );
  });

  test('flags a disallowed scalarValues shorthand destructuring access', async () => {
    await withSyntheticProgram(
      [
        "import type { AccessibilityCapture } from '../ports/browser.js';",
        'declare const capture: AccessibilityCapture;',
        'const { scalarValues } = capture;',
        'void scalarValues;',
      ].join('\n'),
      (program, portsModuleFileName, callerFileName) => {
        expectOneSaneAccessSite(program, portsModuleFileName, callerFileName, {
          field: 'scalarValues',
          allowed: false,
        });
      },
    );
  });

  test('flags a disallowed aliased rawYaml destructuring access', async () => {
    await withSyntheticProgram(
      [
        "import type { AccessibilityCapture } from '../ports/browser.js';",
        'declare const capture: AccessibilityCapture;',
        'const { rawYaml: localRawYaml } = capture;',
        'void localRawYaml;',
      ].join('\n'),
      (program, portsModuleFileName, callerFileName) => {
        expectOneSaneAccessSite(program, portsModuleFileName, callerFileName, {
          field: 'rawYaml',
          allowed: false,
        });
      },
    );
  });

  test('records an allowed destructuring access without flagging it', async () => {
    await withSyntheticProgram(
      [
        "import type { AccessibilityCapture } from '../ports/browser.js';",
        'declare const capture: AccessibilityCapture;',
        'const { scalarValues } = capture;',
        'void scalarValues;',
      ].join('\n'),
      (program, portsModuleFileName, callerFileName) => {
        const sites = scanAccessibilityCaptureFieldAccess(
          program,
          portsModuleFileName,
          new Set([callerFileName]),
        );

        expect(sites).toHaveLength(1);
        expect(sites[0]).toMatchObject({
          fileName: callerFileName,
          field: 'scalarValues',
          allowed: true,
        });
      },
    );
  });

  test('ignores an unrelated same-named local variable', async () => {
    await withSyntheticProgram(
      "const rawYaml = 'not an accessibility capture';\nvoid rawYaml;",
      (program, portsModuleFileName) => {
        expect(scanAccessibilityCaptureFieldAccess(program, portsModuleFileName, new Set())).toEqual([]);
      },
    );
  });

  test('ignores a structurally similar but unrelated value', async () => {
    await withSyntheticProgram(
      [
        "import type { AccessibilityCapture } from '../ports/browser.js';",
        'declare const capture: AccessibilityCapture;',
        "const unrelated: { rawYaml: string; scalarValues: readonly string[] } = { rawYaml: 'x', scalarValues: [] };",
        'void capture.tree;',
        'void unrelated.rawYaml;',
        'const { scalarValues } = unrelated;',
        'void scalarValues;',
      ].join('\n'),
      (program, portsModuleFileName) => {
        expect(scanAccessibilityCaptureFieldAccess(program, portsModuleFileName, new Set())).toEqual([]);
      },
    );
  });
});
