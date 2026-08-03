import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { computeInputsDigest as aliasComputeInputsDigest } from '#core/ir/digest.js';
import { computeInputsDigest as relativeComputeInputsDigest } from '../src/core/ir/digest.js';
import { scanComputeInputsDigestCalls } from '../tools/digest-scanner.js';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const DIGEST_MODULE_FILE = fileURLToPath(new URL('../src/core/ir/digest.ts', import.meta.url));

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
});
