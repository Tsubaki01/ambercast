import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { computeInputsDigest as aliasComputeInputsDigest } from '#core/ir/digest.js';
import { computeInputsDigest as relativeComputeInputsDigest } from '../src/core/ir/digest.js';
import { scanAccessibilityCaptureFieldAccess } from '../tools/accessibility-capture-scanner.js';
import { scanComputeInputsDigestCalls } from '../tools/digest-scanner.js';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const DIGEST_MODULE_FILE = fileURLToPath(new URL('../src/core/ir/digest.ts', import.meta.url));
const PORTS_MODULE_FILE = fileURLToPath(new URL('../src/ports/browser.ts', import.meta.url));
const REPORT_SCHEMA_MODULE_FILE = fileURLToPath(new URL('../src/report/schema.ts', import.meta.url));
const RUN_MODULE_FILE = fileURLToPath(new URL('../src/usecases/run.ts', import.meta.url));

async function findTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const children = await Promise.all(entries.map(async (entry) => {
    const fileName = join(directory, entry.name);

    if (entry.isDirectory()) {
      return findTypeScriptFiles(fileName);
    }

    return entry.isFile() && fileName.endsWith('.ts') ? [fileName] : [];
  }));

  return children.flat();
}

function exportedType(
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  exportName: string,
): ts.Type {
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  const exported = moduleSymbol === undefined
    ? undefined
    : checker.getExportsOfModule(moduleSymbol).find(({ name }) => name === exportName);

  if (exported === undefined) {
    throw new Error(`Expected ${sourceFile.fileName} to export ${exportName}.`);
  }

  return checker.getDeclaredTypeOfSymbol(exported);
}

describe('architecture guardrails', () => {
  test('scans the current source tree without finding digest call-site violations', async () => {
    const sourceFiles = await findTypeScriptFiles(SOURCE_ROOT);
    const program = ts.createProgram({
      rootNames: sourceFiles,
      options: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2023,
        types: ['node'],
      },
    });

    expect(sourceFiles).toContain(DIGEST_MODULE_FILE);
    expect(sourceFiles.length).toBeGreaterThan(0);
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(program.getSemanticDiagnostics()).toEqual([]);
    const callSites = scanComputeInputsDigestCalls(program, DIGEST_MODULE_FILE);

    expect(callSites.filter((site) => site.violation !== undefined)).toEqual([]);
  });

  test('resolves the core subpath alias to the relative digest module', () => {
    expect(aliasComputeInputsDigest).toBe(relativeComputeInputsDigest);
  });

  test('restricts detection-only accessibility capture fields to the run detector and excludes them from persisted shapes', async () => {
    const sourceFiles = await findTypeScriptFiles(SOURCE_ROOT);
    const program = ts.createProgram({
      rootNames: sourceFiles,
      options: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        strict: true,
        target: ts.ScriptTarget.ES2023,
        types: ['node'],
      },
    });

    expect(sourceFiles).toEqual(expect.arrayContaining([
      PORTS_MODULE_FILE,
      REPORT_SCHEMA_MODULE_FILE,
      RUN_MODULE_FILE,
    ]));
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(program.getSemanticDiagnostics()).toEqual([]);

    const accessSites = scanAccessibilityCaptureFieldAccess(
      program,
      PORTS_MODULE_FILE,
      new Set([RUN_MODULE_FILE]),
    );
    expect(accessSites.filter((site) => !site.allowed)).toEqual([]);
    expect(accessSites).toHaveLength(2);
    expect(accessSites).toEqual(expect.arrayContaining([
      expect.objectContaining({ fileName: RUN_MODULE_FILE, field: 'rawYaml', allowed: true }),
      expect.objectContaining({ fileName: RUN_MODULE_FILE, field: 'scalarValues', allowed: true }),
    ]));
    expect(accessSites.every((site) => site.line > 0 && site.column > 0)).toBe(true);

    const portsModule = program.getSourceFile(PORTS_MODULE_FILE);
    const reportSchemaModule = program.getSourceFile(REPORT_SCHEMA_MODULE_FILE);
    if (portsModule === undefined || reportSchemaModule === undefined) {
      throw new Error('The architecture program must include the ports and report-schema modules.');
    }

    const checker = program.getTypeChecker();
    const pageSnapshot = exportedType(checker, portsModule, 'PageSnapshot');
    const observed = exportedType(checker, reportSchemaModule, 'Observed');
    for (const type of [pageSnapshot, observed]) {
      expect(type.getProperty('rawYaml')).toBeUndefined();
      expect(type.getProperty('scalarValues')).toBeUndefined();
    }
  });
});
