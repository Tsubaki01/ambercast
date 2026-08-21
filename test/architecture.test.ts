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
const PROMPT_ENVELOPE_MODULE_FILE = fileURLToPath(new URL('../src/core/ai/prompt-envelope.ts', import.meta.url));
const RUN_MODULE_FILE = fileURLToPath(new URL('../src/usecases/run.ts', import.meta.url));
const GENERATE_MODULE_FILE = fileURLToPath(new URL('../src/usecases/generate.ts', import.meta.url));
const CHECK_TEST_FILE = fileURLToPath(new URL('./unit/usecases/check.test.ts', import.meta.url));
const CHECK_MODULE_FILE = fileURLToPath(new URL('../src/usecases/check.ts', import.meta.url));
const CHECK_COMMAND_MODULE_FILE = fileURLToPath(new URL('../src/runtime/check-command.ts', import.meta.url));

const PROMPT_ENVELOPE_SPECIFIER = '#core/ai/prompt-envelope.js';
const IR_SCHEMA_SPECIFIER = '#core/ir/schema.js';
const SCHEMA_VERSION_AUTHORITIES = ['GROUNDING_SCHEMA_VERSION', 'PLAN_SCHEMA_VERSION'] as const;

interface GeneratorExecutePromptSite {
  readonly line: number;
  readonly usesSharedComposer: boolean;
}

interface SchemaVersionAuthoritySite {
  readonly authority: string | undefined;
  readonly expression: string;
  readonly kind: 'comparison' | 'property';
  readonly line: number;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : undefined;
}

function valueImportBindings(
  sourceFile: ts.SourceFile,
  moduleSpecifier: string,
  exportNames: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const bindings = new Map<string, string>();

  for (const statement of sourceFile.statements) {
    const importClause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    const namedBindings = importClause?.namedBindings;
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== moduleSpecifier
      || importClause === undefined
      || importClause.isTypeOnly
      || namedBindings === undefined
      || !ts.isNamedImports(namedBindings)
    ) {
      continue;
    }

    for (const element of namedBindings.elements) {
      const exportedName = element.propertyName?.text ?? element.name.text;
      if (!element.isTypeOnly && exportNames.has(exportedName)) {
        bindings.set(element.name.text, exportedName);
      }
    }
  }

  return bindings;
}

function scanGeneratorExecutePrompts(sourceFile: ts.SourceFile): readonly GeneratorExecutePromptSite[] {
  const importedBindings = valueImportBindings(
    sourceFile,
    PROMPT_ENVELOPE_SPECIFIER,
    new Set(['buildGeneratorTask']),
  );
  const sites: GeneratorExecutePromptSite[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'execute'
      && node.arguments[0] !== undefined
      && ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const promptProperty = node.arguments[0].properties.find((property): property is ts.PropertyAssignment => (
        ts.isPropertyAssignment(property) && propertyNameText(property.name) === 'prompt'
      ));
      const initializer = promptProperty?.initializer;
      if (initializer !== undefined) {
        sites.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          usesSharedComposer: ts.isCallExpression(initializer)
            && ts.isIdentifier(initializer.expression)
            && importedBindings.get(initializer.expression.text) === 'buildGeneratorTask',
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sites;
}

function generatorTemplateUsesSharedTaskComposer(sourceFile: ts.SourceFile): boolean {
  const declaration = sourceFile.statements
    .filter(ts.isVariableStatement)
    .flatMap(({ declarationList }) => [...declarationList.declarations])
    .find(({ name }) => ts.isIdentifier(name) && name.text === 'GENERATOR_PROMPT_TEMPLATE');
  const initializer = declaration?.initializer;
  if (
    initializer === undefined
    || !ts.isCallExpression(initializer)
    || !ts.isIdentifier(initializer.expression)
    || initializer.expression.text !== 'staticGrammar'
    || initializer.arguments.length !== 1
  ) {
    return false;
  }

  const taskComposer = initializer.arguments[0];
  if (
    taskComposer === undefined
    || !ts.isCallExpression(taskComposer)
    || !ts.isIdentifier(taskComposer.expression)
    || taskComposer.expression.text !== 'buildGeneratorTask'
    || taskComposer.arguments.length !== 1
  ) {
    return false;
  }

  const taskSlot = taskComposer.arguments[0];
  return taskSlot !== undefined
    && ts.isPropertyAccessExpression(taskSlot)
    && ts.isIdentifier(taskSlot.expression)
    && taskSlot.expression.text === 'PLACEHOLDERS'
    && taskSlot.name.text === 'task';
}

function isSchemaVersionAccess(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node)
    && node.name.text === 'schemaVersion'
  ) || (
    ts.isElementAccessExpression(node)
    && node.argumentExpression !== undefined
    && ts.isStringLiteral(node.argumentExpression)
    && node.argumentExpression.text === 'schemaVersion'
  );
}

function scanSchemaVersionAuthorities(sourceFile: ts.SourceFile): readonly SchemaVersionAuthoritySite[] {
  const bindings = valueImportBindings(
    sourceFile,
    IR_SCHEMA_SPECIFIER,
    new Set(SCHEMA_VERSION_AUTHORITIES),
  );
  const sites: SchemaVersionAuthoritySite[] = [];

  function recordSite(
    kind: SchemaVersionAuthoritySite['kind'],
    node: ts.Node,
    authorityExpression: ts.Expression,
  ): void {
    sites.push({
      authority: ts.isIdentifier(authorityExpression)
        ? bindings.get(authorityExpression.text)
        : undefined,
      expression: authorityExpression.getText(sourceFile),
      kind,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) return;

    if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === 'schemaVersion') {
      recordSite('property', node, node.initializer);
    }

    if (ts.isBinaryExpression(node)) {
      if (isSchemaVersionAccess(node.left)) {
        recordSite('comparison', node, node.right);
      } else if (isSchemaVersionAccess(node.right)) {
        recordSite('comparison', node, node.left);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return sites;
}

function forbiddenCheckImports(sourceFile: ts.SourceFile): string[] {
  const forbiddenSpecifiers: string[] = [];

  function scanSpecifier(
    moduleSpecifier: ts.Expression | undefined,
    bindings: ts.NamedImports | ts.NamespaceImport | ts.NamedExports | ts.NamespaceExport | undefined,
  ): void {
    if (moduleSpecifier === undefined || !ts.isStringLiteral(moduleSpecifier)) {
      return;
    }

    const specifier = moduleSpecifier.text;
    const importsEventOrSecretsPort = isForbiddenSystemPortBinding(specifier, bindings);
    const forbidden = isAiOrBrowserPortSpecifier(specifier)
      || [
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

    if (forbidden) {
      forbiddenSpecifiers.push(specifier);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      scanSpecifier(node.moduleSpecifier, node.importClause?.namedBindings);
    } else if (ts.isExportDeclaration(node)) {
      scanSpecifier(node.moduleSpecifier, node.exportClause);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      scanSpecifier(node.arguments[0], undefined);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return forbiddenSpecifiers;
}

function isAiOrBrowserPortSpecifier(specifier: string): boolean {
  return ['ai', 'browser'].some((port) => (
    specifier === `#ports/${port}.js` || specifier.endsWith(`/ports/${port}.js`)
  ));
}

function isForbiddenSystemPortBinding(
  specifier: string,
  bindings: ts.NamedImports | ts.NamespaceImport | ts.NamedExports | ts.NamespaceExport | undefined,
): boolean {
  if (
    (specifier !== '#ports/system.js' && !specifier.endsWith('/ports/system.js'))
    || bindings === undefined
  ) {
    return false;
  }

  if (ts.isNamespaceImport(bindings) || ts.isNamespaceExport(bindings)) {
    return true;
  }

  if (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)) {
    return false;
  }

  return bindings.elements.some(({ name, propertyName }) => {
    const importedName = propertyName?.text ?? name.text;
    return importedName === 'EventSink' || importedName === 'SecretsProvider';
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
  test('routes the generated AI request through the shared generator task composer', async () => {
    const composedRequest = ts.createSourceFile(
      '/virtual/composed-generator-request.ts',
      [
        "import { buildGeneratorTask as composeTask } from '#core/ai/prompt-envelope.js';",
        "executor.execute({ prompt: composeTask('Generate a deterministic plan.') });",
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );
    const uncomposedThenComposed = ts.createSourceFile(
      '/virtual/uncomposed-then-composed-generator-request.ts',
      [
        "import { buildGeneratorTask as composeTask } from '#core/ai/prompt-envelope.js';",
        "executor.execute({ prompt: 'Generate without the shared policy.' });",
        "executor.execute({ prompt: composeTask('Generate a deterministic plan.') });",
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );
    const composedThenUncomposed = ts.createSourceFile(
      '/virtual/composed-then-uncomposed-generator-request.ts',
      [
        "import { buildGeneratorTask as composeTask } from '#core/ai/prompt-envelope.js';",
        "executor.execute({ prompt: composeTask('Generate a deterministic plan.') });",
        "executor.execute({ prompt: 'Generate without the shared policy.' });",
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );

    expect(scanGeneratorExecutePrompts(composedRequest).map(({ usesSharedComposer }) => usesSharedComposer))
      .toEqual([true]);
    expect(scanGeneratorExecutePrompts(uncomposedThenComposed).map(({ usesSharedComposer }) => usesSharedComposer))
      .toEqual([false, true]);
    expect(scanGeneratorExecutePrompts(composedThenUncomposed).map(({ usesSharedComposer }) => usesSharedComposer))
      .toEqual([true, false]);

    const generateModule = ts.createSourceFile(
      GENERATE_MODULE_FILE,
      await readFile(GENERATE_MODULE_FILE, 'utf8'),
      ts.ScriptTarget.ES2023,
      true,
    );
    const actualSites = scanGeneratorExecutePrompts(generateModule);
    expect(actualSites.length).toBeGreaterThan(0);
    expect(actualSites.every(({ usesSharedComposer }) => usesSharedComposer)).toBe(true);
  });

  test('builds the fingerprint template directly through the shared generator task composer', async () => {
    const sharedComposer = ts.createSourceFile(
      '/virtual/shared-generator-template.ts',
      'export const GENERATOR_PROMPT_TEMPLATE = staticGrammar(buildGeneratorTask(PLACEHOLDERS.task));',
      ts.ScriptTarget.ES2023,
      true,
    );
    const reconstructedComposer = ts.createSourceFile(
      '/virtual/reconstructed-generator-template.ts',
      'export const GENERATOR_PROMPT_TEMPLATE = staticGrammar(`${POLICY.trim()}\\n\\n${PLACEHOLDERS.task}`);',
      ts.ScriptTarget.ES2023,
      true,
    );
    const indirectComposer = ts.createSourceFile(
      '/virtual/indirect-generator-template.ts',
      [
        'const taskSlot = buildGeneratorTask(PLACEHOLDERS.task);',
        'export const GENERATOR_PROMPT_TEMPLATE = staticGrammar(taskSlot);',
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );

    expect(generatorTemplateUsesSharedTaskComposer(sharedComposer)).toBe(true);
    expect(generatorTemplateUsesSharedTaskComposer(reconstructedComposer)).toBe(false);
    expect(generatorTemplateUsesSharedTaskComposer(indirectComposer)).toBe(false);

    const promptEnvelopeModule = ts.createSourceFile(
      PROMPT_ENVELOPE_MODULE_FILE,
      await readFile(PROMPT_ENVELOPE_MODULE_FILE, 'utf8'),
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(generatorTemplateUsesSharedTaskComposer(promptEnvelopeModule)).toBe(true);
  });

  test('uses shared Plan and Grounding version authorities at usecase boundaries', async () => {
    const literalAuthority = ts.createSourceFile(
      '/virtual/literal-schema-versions.ts',
      [
        'const plan = { schemaVersion: 2 };',
        'const grounding = { schemaVersion: 1 };',
        'if (root.schemaVersion !== 1) throw new Error();',
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(scanSchemaVersionAuthorities(literalAuthority)).toEqual([
      { authority: undefined, expression: '2', kind: 'property', line: 1 },
      { authority: undefined, expression: '1', kind: 'property', line: 2 },
      { authority: undefined, expression: '1', kind: 'comparison', line: 3 },
    ]);

    const sharedAuthority = ts.createSourceFile(
      '/virtual/shared-schema-versions.ts',
      [
        "import { GROUNDING_SCHEMA_VERSION, PLAN_SCHEMA_VERSION } from '#core/ir/schema.js';",
        'const plan = { schemaVersion: PLAN_SCHEMA_VERSION };',
        'const grounding = { schemaVersion: GROUNDING_SCHEMA_VERSION };',
        'if (root.schemaVersion !== GROUNDING_SCHEMA_VERSION) throw new Error();',
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(scanSchemaVersionAuthorities(sharedAuthority)).toEqual([
      {
        authority: 'PLAN_SCHEMA_VERSION',
        expression: 'PLAN_SCHEMA_VERSION',
        kind: 'property',
        line: 2,
      },
      {
        authority: 'GROUNDING_SCHEMA_VERSION',
        expression: 'GROUNDING_SCHEMA_VERSION',
        kind: 'property',
        line: 3,
      },
      {
        authority: 'GROUNDING_SCHEMA_VERSION',
        expression: 'GROUNDING_SCHEMA_VERSION',
        kind: 'comparison',
        line: 4,
      },
    ]);

    const indirectAuthority = ts.createSourceFile(
      '/virtual/indirect-schema-version.ts',
      [
        "import { PLAN_SCHEMA_VERSION } from '#core/ir/schema.js';",
        'void PLAN_SCHEMA_VERSION;',
        'const LOCAL_SCHEMA_VERSION = 2;',
        'const plan = { schemaVersion: LOCAL_SCHEMA_VERSION };',
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(scanSchemaVersionAuthorities(indirectAuthority)).toEqual([{
      authority: undefined,
      expression: 'LOCAL_SCHEMA_VERSION',
      kind: 'property',
      line: 4,
    }]);

    const usecases = [
      {
        expectedSites: [
          { authority: 'GROUNDING_SCHEMA_VERSION', kind: 'property' },
          { authority: 'PLAN_SCHEMA_VERSION', kind: 'property' },
          { authority: 'PLAN_SCHEMA_VERSION', kind: 'property' },
        ],
        fileName: GENERATE_MODULE_FILE,
        usecase: 'generate',
      },
      {
        expectedSites: [{ authority: 'PLAN_SCHEMA_VERSION', kind: 'property' }],
        fileName: CHECK_MODULE_FILE,
        usecase: 'check',
      },
      {
        expectedSites: [
          { authority: 'GROUNDING_SCHEMA_VERSION', kind: 'property' },
          { authority: 'GROUNDING_SCHEMA_VERSION', kind: 'comparison' },
          { authority: 'PLAN_SCHEMA_VERSION', kind: 'property' },
        ],
        fileName: RUN_MODULE_FILE,
        usecase: 'run',
      },
    ];
    const scans = await Promise.all(usecases.map(async ({ expectedSites, fileName, usecase }) => {
      const sourceFile = ts.createSourceFile(
        fileName,
        await readFile(fileName, 'utf8'),
        ts.ScriptTarget.ES2023,
        true,
      );
      const sites = scanSchemaVersionAuthorities(sourceFile);
      return {
        expectedSites,
        lines: sites.map(({ line }) => line),
        sites: sites.map(({ authority, kind }) => ({ authority, kind })),
        usecase,
      };
    }));

    expect(scans.map(({ expectedSites, sites, usecase }) => ({ expectedSites, sites, usecase })))
      .toEqual(usecases.map(({ expectedSites, usecase }) => ({
        expectedSites,
        sites: expectedSites,
        usecase,
      })));
    expect(scans.every(({ lines }) => lines.length > 0 && lines.every((line) => line > 0))).toBe(true);
  });

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

    const directAiAndBrowserPortsSyntheticFile = ts.createSourceFile(
      '/virtual/forbidden-check-ai-and-browser-ports.ts',
      [
        "import type { AiExecutor } from '#ports/ai.js';",
        "import type { BrowserDriver } from '#ports/browser.js';",
      ].join('\n'),
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(forbiddenCheckImports(directAiAndBrowserPortsSyntheticFile)).toEqual([
      '#ports/ai.js',
      '#ports/browser.js',
    ]);

    const systemNamespaceSyntheticFile = ts.createSourceFile(
      '/virtual/forbidden-check-system-namespace.ts',
      "import * as System from '#ports/system.js';",
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(forbiddenCheckImports(systemNamespaceSyntheticFile)).toEqual(['#ports/system.js']);

    const systemReExportSyntheticFile = ts.createSourceFile(
      '/virtual/forbidden-check-system-re-export.ts',
      "export { EventSink } from '#ports/system.js';",
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(forbiddenCheckImports(systemReExportSyntheticFile)).toEqual(['#ports/system.js']);

    const dynamicAdapterImportSyntheticFile = ts.createSourceFile(
      '/virtual/forbidden-check-dynamic-adapter-import.ts',
      "async function load() { return import('#adapters/ai/registry.js'); }",
      ts.ScriptTarget.ES2023,
      true,
    );
    expect(forbiddenCheckImports(dynamicAdapterImportSyntheticFile)).toEqual(['#adapters/ai/registry.js']);
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
