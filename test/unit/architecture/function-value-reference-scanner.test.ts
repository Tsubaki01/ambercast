import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import {
  scanFunctionValueReferences,
  type FunctionValueReferenceScan,
} from '../../../tools/function-value-reference-scanner.js';

const targetSource = [
  'export function target(): void {}',
  'export function other(): void {}',
].join('\n');

type Coordinate = {
  readonly fileName: string;
  readonly line: number;
  readonly column: number;
};

async function withProgram(
  files: Readonly<Record<string, string>>,
  assertion: (program: ts.Program, names: Readonly<Record<string, string>>) => void,
  compilerOptions: ts.CompilerOptions = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-function-value-reference-'));
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
        ...compilerOptions,
      },
    });
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(program.getSemanticDiagnostics()).toEqual([]);
    assertion(program, names);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function sourceFile(program: ts.Program, fileName: string): ts.SourceFile {
  const source = program.getSourceFile(fileName);
  if (source === undefined) throw new Error(`Missing source file ${fileName}.`);
  return source;
}

function canonicalDeclaration(program: ts.Program, targetFileName: string): ts.FunctionDeclaration {
  const declaration = sourceFile(program, targetFileName).statements.find((statement): statement is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'target'
  ));
  if (declaration === undefined) throw new Error('Synthetic target declaration is missing.');
  return declaration;
}

function coordinate(node: ts.Node): Coordinate {
  const source = node.getSourceFile();
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { fileName: source.fileName, line: position.line + 1, column: position.character + 1 };
}

function expectedCoordinate(fileName: string, source: string, line: number, marker: string): Coordinate {
  const lineText = source.split('\n')[line - 1];
  if (lineText === undefined) throw new Error(`Missing line ${line}.`);
  const index = lineText.indexOf(marker);
  if (index < 0) throw new Error(`Missing marker ${marker} on line ${line}.`);
  return { fileName, line, column: index + 1 };
}

function expectScan(
  scan: FunctionValueReferenceScan,
  callerFileName: string,
  source: string,
  directCalls: readonly (readonly [number, string])[],
  unsafeReferences: readonly (readonly [number, string])[],
): void {
  expect({
    directCalls: scan.directCalls.map(({ call }) => coordinate(call)),
    unsafeReferences: scan.unsafeReferences.map(({ node }) => coordinate(node)),
  }).toEqual({
    directCalls: directCalls.map(([line, marker]) => expectedCoordinate(callerFileName, source, line, marker)),
    unsafeReferences: unsafeReferences.map(([line, marker]) => expectedCoordinate(callerFileName, source, line, marker)),
  });
}

async function withCaller(
  source: string,
  assertion: (scan: FunctionValueReferenceScan, names: Readonly<Record<string, string>>) => void,
  caller = 'src/caller.ts',
  compilerOptions: ts.CompilerOptions = {},
): Promise<void> {
  await withProgram({ 'src/target.ts': targetSource, [caller]: source }, (program, names) => {
    const targetFileName = names['src/target.ts'];
    if (targetFileName === undefined) throw new Error('Synthetic target module is missing.');
    const declaration = canonicalDeclaration(program, targetFileName);
    const scan = scanFunctionValueReferences(
      program,
      declaration,
      (symbol) => symbol.declarations?.includes(declaration) ?? false,
    );
    assertion(scan, names);
  }, compilerOptions);
}

describe('scanFunctionValueReferences()', () => {
  test.each([
    ['a direct exact callee', ["import { target } from './target.js';", 'target();'].join('\n'), [[2, 'target()']], []],
    ['a renamed-import direct call', ["import { target as alias } from './target.js';", 'alias();'].join('\n'), [[2, 'alias()']], []],
    ['a namespace-qualified direct call', ["import * as api from './target.js';", 'api.target();'].join('\n'), [[2, 'api.target()']], []],
  ] as const)('classifies %s as an exact direct call', async (_name, source, directCalls, unsafeReferences) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, directCalls, unsafeReferences);
    });
  });

  test.each([
    ['a local rebind', ["import { target } from './target.js';", 'const alias = target;'].join('\n'), [[2, 'target']]],
    ['a shorthand declaration-destructuring alias', ["import * as api from './target.js';", 'const { target } = api;'].join('\n'), [[2, 'target']]],
    ['a renamed declaration-destructuring alias', ["import * as api from './target.js';", 'const { target: alias } = api;'].join('\n'), [[2, 'alias']]],
    ['an assignment-destructuring alias', ["import * as api from './target.js';", 'let alias: unknown;', '({ target: alias } = api);'].join('\n'), [[3, 'alias']]],
    ['a property extraction', ["import * as api from './target.js';", 'const alias = api.target;'].join('\n'), [[2, 'target']]],
    ['an element extraction', ["import * as api from './target.js';", "const alias = api['target'];"].join('\n'), [[2, "api['target']"]]],
    ['.bind()', ["import { target } from './target.js';", 'const rebound = target.bind(undefined);'].join('\n'), [[2, 'target']]],
    ['.call()', ["import { target } from './target.js';", 'target.call(undefined);'].join('\n'), [[2, 'target']]],
    ['.apply()', ["import { target } from './target.js';", 'target.apply(undefined, []);'].join('\n'), [[2, 'target']]],
    ['passing as an argument', ["import { target } from './target.js';", 'declare function accept(value: unknown): void;', 'accept(target);'].join('\n'), [[3, 'target']]],
    ['returning it', ["import { target } from './target.js';", 'function value(): unknown { return target; }'].join('\n'), [[2, 'target']]],
    ['storing it in an object literal', ["import { target } from './target.js';", 'const value = { target };'].join('\n'), [[2, 'target']]],
    ['storing it in an array literal', ["import { target } from './target.js';", 'const value = [target];'].join('\n'), [[2, 'target']]],
    ['a plain value re-export', "export { target } from './target.js';", [[1, 'target']]],
    ['a renamed value re-export', "export { target as forwarded } from './target.js';", [[1, 'target']]],
    ['a star value re-export', "export * from './target.js';", [[1, 'export']]],
  ] as const)('classifies %s as one unsafe reference at its first extraction point', async (_name, source, unsafeReferences) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], unsafeReferences);
    });
  });

  test('classifies a potential computed selection used as a callee as unsafe at the callee', async () => {
    const source = [
      "import * as api from './target.js';",
      "declare const key: 'target' | 'other';",
      'api[key]();',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[3, 'api[key]']]);
    });
  });

  test.each([
    [
      'declaration destructuring',
      [
        "import * as api from './target.js';",
        'declare const source: any;',
        'const { outer: { target: alias } } = source;',
      ].join('\n'),
      3,
    ],
    [
      'assignment destructuring',
      [
        "import * as api from './target.js';",
        'declare const source: any;',
        'let alias: unknown;',
        '({ outer: { target: alias } } = source);',
      ].join('\n'),
      4,
    ],
  ] as const)('propagates an any outer source through nested %s', async (_name, source, line) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[line, 'alias']]);
    });
  });

  test('excludes declaration-introduction positions from both inventories', async () => {
    const source = "import { target } from './target.js';";
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], []);
    });
  });

  test('excludes erased type positions from both inventories', async () => {
    const source = [
      "import { target } from './target.js';",
      'type TargetFunction = typeof target;',
      'declare const value: TargetFunction;',
      'void value;',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], []);
    });
  });

  test('continues into a none-classified callee arguments and reports the protected value', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare function unrelated(value: unknown): void;',
      'unrelated(target);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[3, 'target']]);
    });
  });

  test('keeps transparent receiver casts exact at their owning callee nodes', async () => {
    const source = [
      "import * as api from './target.js';",
      '(api as typeof api).target();',
      "(api as typeof api)['target']();",
      '(api as typeof api as typeof api).target();',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [
        [2, '(api as typeof api).target()'],
        [3, "(api as typeof api)['target']()"],
        [4, '(api as typeof api as typeof api).target()'],
      ], []);
    });
  });

  test('uses index-slot type evidence without over-reporting unknown or array slots', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare const unknownValues: Record<string, unknown>;',
      'declare const anyValues: any[];',
      'declare const numericValues: number[];',
      "declare const optionalValues: Record<string, typeof target | undefined>;",
      "declare const unionValues: Record<string, typeof target | string>;",
      'declare const compatibleValues: Record<string, () => void>;',
      "void unknownValues['target'];",
      'if (Array.isArray(anyValues)) void anyValues[0];',
      'void numericValues[0];',
      "void optionalValues['target'];",
      "void unionValues['target'];",
      "void compatibleValues['target'];",
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [11, "optionalValues['target']"],
        [12, "unionValues['target']"],
        [13, "compatibleValues['target']"],
      ]);
    }, undefined, { noUncheckedIndexedAccess: true });
  });

  test('reports exactly two aggregate escapes across the specified alias chain', async () => {
    const source = [
      "import * as api from './target.js';",
      'const ns = api;',
      'declare function consume(value: unknown): void;',
      'consume(ns);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [2, 'api;'],
        [4, 'ns);'],
      ]);
    });
  });

  test('reports aggregates whose properties have protected or structurally equivalent function types', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare const holder: { fn: typeof target };',
      'declare const compatible: { fn: () => void };',
      'declare function consume(value: unknown): void;',
      'consume(holder);',
      'consume(compatible);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [5, 'holder'],
        [6, 'compatible'],
      ]);
    });
  });

  test('reports an aggregate property type that accepts the target in only the required direction', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare const oneWayCompatible: { fn: (value: string) => void };',
      'declare function consume(value: unknown): void;',
      'consume(oneWayCompatible);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[4, 'oneWayCompatible']]);
    });
  });

  test('uses the innermost type across interleaved await and transparent wrappers', async () => {
    const source = [
      "import * as api from './target.js';",
      'async function escape(): Promise<void> {',
      '  void ((await (api as unknown)) as unknown);',
      '}',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[3, '((await']]);
    });
  });

  test('continues into a reported destructuring leaf computed key', async () => {
    const source = [
      "import * as api from './target.js';",
      "declare function key(value: unknown): 'target';",
      'const { [key(api)]: alias } = api;',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [3, 'alias'],
        [3, 'api)'],
      ]);
    });
  });

  test('combines a parameter declaration type with its cast-hidden default source type', async () => {
    const source = [
      "import * as api from './target.js';",
      'function bind({ target: alias }: { target: string } =',
      '  (api as unknown as { target: string })): void { void alias; }',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[2, 'alias']]);
    });
  });

  test('reports aggregate escapes independently across aliases and namespace transfers', async () => {
    const source = [
      "import * as api from './target.js';",
      'const ns = api;',
      'declare function consume(value: unknown): void;',
      'consume(ns);',
      'let assigned: unknown;',
      'assigned = ns;',
      'const spread = { ...ns };',
      'Object.assign({}, ns);',
      'const cast = ns as typeof ns;',
      'const { ...declRest } = ns;',
      'let assignmentRest: Omit<typeof ns, never>;',
      '({ ...assignmentRest } = ns);',
      'const { ...castRest } = (ns as typeof ns);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [2, 'api'], [4, 'ns);'], [6, 'ns;'], [7, 'ns };'], [8, 'Object.assign'],
        [8, 'ns);'], [9, 'ns as'], [10, 'declRest'], [12, 'assignmentRest'],
        [13, 'castRest'],
      ]);
    });
  });

  test('propagates nested declaration and assignment sources to rest bindings', async () => {
    const source = [
      "import * as api from './target.js';",
      'declare const source: { outer: typeof api };',
      'const { outer: { ...declarationRest } } = source;',
      'let assignmentRest: unknown;',
      '({ outer: { ...assignmentRest } } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [3, 'declarationRest'],
        [5, 'assignmentRest'],
      ]);
    });
  });

  test('judges assignment-destructuring targets from their sources instead of their declared types', async () => {
    const source = [
      "import * as api from './target.js';",
      'declare const safeRestSource: {};',
      'let safeRestTarget: { fn?: typeof api.target };',
      '({ ...safeRestTarget } = safeRestSource);',
      'declare const safeLeafSource: { other: {} };',
      'let safeLeafTarget: { fn?: typeof api.target };',
      '({ other: safeLeafTarget } = safeLeafSource);',
      'let unsafeRestTarget: unknown;',
      '({ ...unsafeRestTarget } = api);',
      'let unsafeLeafTarget: unknown;',
      '({ target: unsafeLeafTarget } = api);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [9, 'unsafeRestTarget'],
        [11, 'unsafeLeafTarget'],
      ]);
    });
  });

  test('reports a function storage point without following the later slot read', async () => {
    const source = [
      "import { target } from './target.js';",
      'const slot: { value?: typeof target } = {};',
      'slot.value = target;',
      'void slot.value;',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[3, 'target;']]);
    });
  });

  test('continues through a classified callee receiver and reports storage inside it', async () => {
    const source = [
      "import * as api from './target.js';",
      'const bag: Record<string, unknown> = {};',
      "((bag['x'] = api.target, api).target)();",
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [[3, "((bag['x']"]], [
        [3, 'target, api'],
        [3, 'api).target'],
      ]);
    });
  });

  test('reports a dynamically imported protected namespace at its import expression', async () => {
    const source = [
      "async function load(): Promise<void> { const api = await import('./target.js'); void api; }",
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [1, "await import('./target.js')"],
        [1, 'api;'],
      ]);
    });
  });

  test('does not inspect declaration names and remains cycle-safe for recursive target-containing types', async () => {
    const source = [
      "import { target } from './target.js';",
      "import * as api from './target.js';",
      'interface A { child?: C; }',
      'interface C { previous?: A; api: typeof api; }',
      'type Alias = A;',
      'declare const recursive: A;',
      'void recursive;',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[7, 'recursive']]);
    });
  });

  test('excludes a target-containing type parameter declaration name', async () => {
    const source = [
      "import * as api from './target.js';",
      'function inspect<T extends { api: typeof api }>(): void {}',
      'void inspect;',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], []);
    });
  });
});
