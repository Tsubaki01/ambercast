import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { computeInputsDigest as aliasComputeInputsDigest } from '#core/ir/digest.js';
import { computeInputsDigest as relativeComputeInputsDigest } from '../src/core/ir/digest.js';
import { scanAccessibilityCaptureFieldAccess } from '../tools/accessibility-capture-scanner.js';
import { scanComputeInputsDigestCalls } from '../tools/digest-scanner.js';
import { scanFillSecretCallSites } from '../tools/fill-secret-call-scanner.js';

const SOURCE_ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const DIGEST_MODULE_FILE = fileURLToPath(new URL('../src/core/ir/digest.ts', import.meta.url));
const PORTS_MODULE_FILE = fileURLToPath(new URL('../src/ports/browser.ts', import.meta.url));
const REPORT_SCHEMA_MODULE_FILE = fileURLToPath(new URL('../src/report/schema.ts', import.meta.url));
const RUN_MODULE_FILE = fileURLToPath(new URL('../src/usecases/run.ts', import.meta.url));
const CHECK_TEST_FILE = fileURLToPath(new URL('./unit/usecases/check.test.ts', import.meta.url));
const CHECK_MODULE_FILE = fileURLToPath(new URL('../src/usecases/check.ts', import.meta.url));
const CHECK_COMMAND_MODULE_FILE = fileURLToPath(new URL('../src/runtime/check-command.ts', import.meta.url));

function forbiddenCheckImports(sourceFile: ts.SourceFile): string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      return [];
    }

    const specifier = statement.moduleSpecifier.text;
    const namedBindings = statement.importClause?.namedBindings;
    const importsEventOrSecretsPort = (specifier === '#ports/system.js' || specifier.endsWith('/ports/system.js'))
      && namedBindings !== undefined
      && ts.isNamedImports(namedBindings)
      && namedBindings.elements.some(({ name }) => name.text === 'EventSink' || name.text === 'SecretsProvider');
    const forbidden = [
      'fake-ai-executor',
      'fake-browser-driver',
      'fake-ai-action-controller',
      'fake-browser-session',
      'fake-secrets-provider',
      'create-recording-event-sink',
      'noop-event-sink',
      'env-secrets-provider',
    ].some((fragment) => specifier.includes(fragment))
      || specifier.startsWith('#adapters/ai/')
      || specifier.startsWith('#adapters/browser/')
      || specifier.endsWith('/create-ambercast.js')
      || specifier.endsWith('/resolve-ai-provider.js')
      || importsEventOrSecretsPort;

    return forbidden ? [specifier] : [];
  });
}

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
  test('keeps check tests, usecase, and runtime composition free of AI/browser, event, and secrets imports', async () => {
    const checkFiles = [CHECK_TEST_FILE, CHECK_MODULE_FILE, CHECK_COMMAND_MODULE_FILE];
    const parsedFiles = await Promise.all(checkFiles.map(async (fileName) => (
      ts.createSourceFile(fileName, await readFile(fileName, 'utf8'), ts.ScriptTarget.ES2023, true)
    )));

    expect(parsedFiles.map(forbiddenCheckImports)).toEqual([[], [], []]);

    const syntheticFile = ts.createSourceFile(
      '/virtual/forbidden-check-import.ts',
      "import { x } from './fake-ai-executor.js';",
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(forbiddenCheckImports(syntheticFile)).toEqual(['./fake-ai-executor.js']);

    const eventAndSecretsSyntheticFile = ts.createSourceFile(
      '/virtual/forbidden-check-event-and-secrets-imports.ts',
      [
        "import type { EventSink } from '#ports/system.js';",
        "import { createNoopEventSink } from '#adapters/system/noop-event-sink.js';",
        "import { createRecordingEventSink } from '../../test/doubles/create-recording-event-sink.js';",
        "import { createEnvSecretsProvider } from '#adapters/system/env-secrets-provider.js';",
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(forbiddenCheckImports(eventAndSecretsSyntheticFile)).toEqual([
      '#ports/system.js',
      '#adapters/system/noop-event-sink.js',
      '../../test/doubles/create-recording-event-sink.js',
      '#adapters/system/env-secrets-provider.js',
    ]);
  });

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

  test('restricts browser secret-fill calls to the materialized-action dispatcher', async () => {
    const sourceFiles = await findTypeScriptFiles(SOURCE_ROOT);
    const tsconfigFileName = ts.sys.resolvePath('tsconfig.json');
    const configFile = ts.readConfigFile(tsconfigFileName, ts.sys.readFile);
    if (configFile.error !== undefined) {
      throw new Error(`The architecture test could not read ${tsconfigFileName}.`);
    }
    const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(tsconfigFileName));
    const program = ts.createProgram({
      rootNames: sourceFiles,
      options: { ...parsedConfig.options, noEmit: true },
    });

    expect(sourceFiles).toEqual(expect.arrayContaining([PORTS_MODULE_FILE, RUN_MODULE_FILE]));
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(program.getSemanticDiagnostics()).toEqual([]);

    const callSites = scanFillSecretCallSites(
      program,
      PORTS_MODULE_FILE,
      new Set([RUN_MODULE_FILE]),
    );

    expect(callSites.every((site) => site.allowed)).toBe(true);
    expect(callSites).toHaveLength(1);

    const runModule = program.getSourceFile(RUN_MODULE_FILE);
    if (runModule === undefined) {
      throw new Error('The architecture program must include the run module.');
    }
    const dispatcher = runModule.statements.find((statement): statement is ts.FunctionDeclaration => (
      ts.isFunctionDeclaration(statement) && statement.name?.text === 'performMaterializedAction'
    ));
    if (dispatcher?.body === undefined) {
      throw new Error('The run module must declare the materialized-action dispatcher with a body.');
    }

    const bodyStartLine = runModule.getLineAndCharacterOfPosition(dispatcher.body.getStart(runModule)).line + 1;
    const bodyEndLine = runModule.getLineAndCharacterOfPosition(dispatcher.body.getEnd()).line + 1;
    expect(callSites[0]).toMatchObject({ fileName: RUN_MODULE_FILE, allowed: true });
    expect(callSites[0]?.line).toBeGreaterThan(bodyStartLine);
    expect(callSites[0]?.line).toBeLessThan(bodyEndLine);
    expect(dispatcher.parameters).toHaveLength(2);
    expect(dispatcher.parameters[1]?.type?.getText(runModule)).toBe('BrowserSession');

    const portsFileName = '/virtual/ports.ts';
    const forbiddenFileName = '/virtual/forbidden.ts';
    const virtualSources = new Map<string, string>([
      [portsFileName, 'export interface BrowserSession { fillSecret(): void; }'],
      [
        forbiddenFileName,
        [
          "import type { BrowserSession } from './ports.js';",
          'declare const session: BrowserSession;',
          'session.fillSecret();',
          "session['fillSecret']();",
        ].join('\n'),
      ],
    ]);
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2023,
    };
    const host = ts.createCompilerHost(options, true);
    const originalFileExists = host.fileExists.bind(host);
    const originalDirectoryExists = host.directoryExists?.bind(host) ?? (() => false);
    const originalReadFile = host.readFile.bind(host);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.fileExists = (fileName) => virtualSources.has(fileName) || originalFileExists(fileName);
    host.directoryExists = (directoryName) => directoryName === '/virtual' || originalDirectoryExists(directoryName);
    host.readFile = (fileName) => virtualSources.get(fileName) ?? originalReadFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
      const text = virtualSources.get(fileName);
      return text === undefined
        ? originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
        : ts.createSourceFile(fileName, text, languageVersion, true);
    };
    const virtualProgram = ts.createProgram({
      rootNames: [...virtualSources.keys()],
      options,
      host,
    });

    expect(scanFillSecretCallSites(virtualProgram, portsFileName, new Set())).toEqual([
      expect.objectContaining({ fileName: forbiddenFileName, line: 3, allowed: false }),
      expect.objectContaining({ fileName: forbiddenFileName, line: 4, allowed: false }),
    ]);
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
