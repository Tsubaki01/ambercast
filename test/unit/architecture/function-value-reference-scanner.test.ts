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

function expectUnsafeReferenceNodes(
  scan: FunctionValueReferenceScan,
  expected: readonly (readonly [string, ts.SyntaxKind])[],
): void {
  expect(scan.unsafeReferences.map(({ node }) => ({ text: node.getText(), kind: node.kind }))).toEqual(
    expected.map(([text, kind]) => ({ text, kind })),
  );
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

  test.each([
    [
      'a for-of binding',
      [
        "import { target } from './target.js';",
        'declare const items: any[];',
        'for (const { target: alias } of items) void alias;',
      ].join('\n'),
      3,
    ],
    [
      'a catch-clause binding',
      [
        "import { target } from './target.js';",
        'try { throw undefined; } catch ({ target: alias }: any) { void alias; }',
      ].join('\n'),
      2,
    ],
  ] as const)('propagates an any source through %s', async (_name, source, line) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[line, 'alias']]);
    });
  });

  test.each([
    [
      'declaration destructuring',
      [
        "import { target } from './target.js';",
        'declare const source: { x: [typeof target] };',
        'const { x: [alias] } = source;',
      ].join('\n'),
      3,
    ],
    [
      'assignment destructuring',
      [
        "import { target } from './target.js';",
        'declare const source: { x: [typeof target] };',
        'let alias: unknown;',
        '({ x: [alias] } = source);',
      ].join('\n'),
      4,
    ],
    [
      'parameter destructuring',
      [
        "import { target } from './target.js';",
        'function bind({ x: [alias] }: { x: [typeof target] }): void { alias(); }',
      ].join('\n'),
      2,
    ],
  ] as const)('propagates a nested array element through %s', async (_name, source, line) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[line, 'alias']]);
    });
  });

  test('uses the precise heterogeneous tuple element type for nested array destructuring', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare const source: { x: [string, typeof target] };',
      'const { x: [safe, alias] } = source;',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[3, 'alias']]);
    });
  });

  test.each([
    [
      'a property-access target',
      [
        "import { target } from './target.js';",
        'declare const source: { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        '({ x: [sink.alias] } = source);',
      ].join('\n'),
      [[4, 'sink.alias']],
    ],
    [
      'an element-access target',
      [
        "import { target } from './target.js';",
        'declare const source: { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        "({ x: [sink['alias']] } = source);",
      ].join('\n'),
      [[4, "sink['alias']"]],
    ],
  ] as const)('propagates a nested array element to %s', async (_name, source, unsafeReferences) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], unsafeReferences);
    });
  });

  test.each([
    [
      'a renamed nested-object target',
      [
        "import * as api from './target.js';",
        'declare const source: { x: [typeof api] };',
        'let alias: unknown;',
        '({ x: [{ target: alias }] } = source);',
      ].join('\n'),
      [[4, 'alias']],
    ],
    [
      'a shorthand nested-object target',
      [
        "import * as api from './target.js';",
        'declare const source: { x: [typeof api] };',
        'let target: unknown;',
        '({ x: [{ target }] } = source);',
      ].join('\n'),
      [[4, 'target }']],
    ],
  ] as const)('propagates a nested array element through %s', async (_name, source, unsafeReferences) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], unsafeReferences);
    });
  });

  test('selects only the matching key in a nested array-element object target', async () => {
    const source = [
      "import * as api from './target.js';",
      'declare const source: { x: [typeof api & { other: string }] };',
      'let alias: unknown;',
      'let safe: unknown;',
      '({ x: [{ target: alias, other: safe }] } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[5, 'alias']]);
    });
  });

  test('uses the precise heterogeneous tuple element type through the nested array-object fallback', async () => {
    const source = [
      "import * as api from './target.js';",
      'declare const source: { x: [typeof api, { target: string }] };',
      'let matching: unknown;',
      'let safe: unknown;',
      '({ x: [{ target: matching }, { target: safe }] } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[5, 'matching']]);
    });
  });

  test('preserves a target-identifying property-access receiver beside its array-slot finding', async () => {
    const source = [
      "import { target as dyn } from './target.js';",
      'declare const source: { x: [typeof dyn] };',
      '({ x: [(dyn as typeof dyn & { alias: unknown }).alias] } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [3, '(dyn as'],
        [3, 'dyn as'],
      ]);
    });
  });

  test('preserves a target-identifying element-access computed key beside its array-slot finding', async () => {
    const source = [
      "import * as api from './target.js';",
      'declare const source: { x: [typeof api.target] };',
      'declare const sink: { [key: string]: unknown };',
      '({ x: [sink[api.target.name]] } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [
        [4, 'sink[api.target.name]'],
        [4, 'target.name'],
      ]);
    });
  });

  test.each([
    ['a parenthesized property-access target', '[(sink.alias)]', 'sink.alias', ts.SyntaxKind.PropertyAccessExpression],
    ['an as-cast property-access target', '[sink.alias as unknown]', 'sink.alias', ts.SyntaxKind.PropertyAccessExpression],
    ['a satisfies property-access target', '[sink.alias satisfies unknown]', 'sink.alias', ts.SyntaxKind.PropertyAccessExpression],
    ['a non-null property-access target', '[sink.alias!]', 'sink.alias', ts.SyntaxKind.PropertyAccessExpression],
    ['an angle-bracket-cast property-access target', '[<unknown>sink.alias]', 'sink.alias', ts.SyntaxKind.PropertyAccessExpression],
    ['a double-parenthesized property-access target', '[((sink.alias))]', 'sink.alias', ts.SyntaxKind.PropertyAccessExpression],
    ["a parenthesized element-access target", "[(sink['alias'])]", "sink['alias']", ts.SyntaxKind.ElementAccessExpression],
  ] as const)('reports %s at its inner owning node', async (_name, element, text, kind) => {
    const source = [
      "import { target } from './target.js';",
      'declare const source: { x: [typeof target] };',
      'declare const sink: { alias: unknown };',
      `({ x: ${element} } = source);`,
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[4, text]]);
      expectUnsafeReferenceNodes(scan, [[text, kind]]);
    });
  });

  test('reports a wrapped bare identifier at a non-zero tuple slot', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare const source: { x: [string, typeof target] };',
      'let unrelated: string;',
      'let alias: unknown;',
      '({ x: [unrelated, (alias)] } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[5, 'alias']]);
      expectUnsafeReferenceNodes(scan, [['alias', ts.SyntaxKind.Identifier]]);
    });
  });

  test.each([
    [
      'a wrapped element whose source slot is unrelated',
      [
        "import { target } from './target.js';",
        'declare const source: { x: [string] };',
        'declare const other: { value: unknown };',
        '({ x: [(other.value)] } = source);',
      ].join('\n'),
      [],
    ],
    [
      'a wrapped element nested two object levels deep',
      [
        "import { target } from './target.js';",
        'declare const source: { y: { x: [typeof target] } };',
        'declare const sink: { alias: unknown };',
        '({ y: { x: [(sink.alias)] } } = source);',
      ].join('\n'),
      [[4, 'sink.alias']],
      [['sink.alias', ts.SyntaxKind.PropertyAccessExpression]],
    ],
      [
      'a wrapped non-array assignment target at its current regression value',
      [
        "import { target } from './target.js';",
        'declare const source: { x: typeof target };',
        'declare const sink: { alias: unknown };',
        '({ x: (sink.alias) } = source);',
      ].join('\n'),
      [],
    ],
  ] as const)('handles %s', async (_name, source, unsafeReferences, unsafeReferenceNodes?) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], unsafeReferences);
      if (unsafeReferenceNodes !== undefined) expectUnsafeReferenceNodes(scan, unsafeReferenceNodes);
    });
  });

  test.each([
    [
      'an any[] iterable',
      [
        "import { target } from './target.js';",
        'declare const sink: { alias: unknown };',
        'declare const arr: any[];',
        'for ({ x: [sink.alias] } of arr) {}',
      ].join('\n'),
      [[4, 'sink.alias']],
    ],
    [
      'a concrete array iterable without reporting the iterable itself',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const arr: SourceItem[];',
        'for ({ x: [sink.alias] } of arr) {}',
      ].join('\n'),
      [[5, 'sink.alias']],
    ],
    [
      'a Set iterable through the Symbol.iterator fallback',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const set: Set<SourceItem>;',
        'for ({ x: [sink.alias] } of set) {}',
      ].join('\n'),
      [[5, 'sink.alias']],
    ],
    [
      'a wrapped target through a Set iterable',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const set: Set<SourceItem>;',
        'for ({ x: [(sink.alias)] } of set) {}',
      ].join('\n'),
      [[5, 'sink.alias']],
    ],
    [
      'an Iterable<any> through the Symbol.iterator fallback',
      [
        "import { target } from './target.js';",
        'declare const sink: { alias: unknown };',
        'declare const iterable: Iterable<any>;',
        'for ({ x: [sink.alias] } of iterable) {}',
      ].join('\n'),
      [[4, 'sink.alias']],
    ],
    [
      'a bare any iterable',
      [
        "import { target } from './target.js';",
        'declare const sink: { alias: unknown };',
        'declare const items: any;',
        'for ({ x: [sink.alias] } of items) {}',
      ].join('\n'),
      [[4, 'sink.alias']],
    ],
    [
      'a bare unknown iterable',
      [
        "import { target } from './target.js';",
        'declare const sink: { alias: unknown };',
        'declare const items: unknown;',
        '// @ts-expect-error The bare iterable value is intentionally unknown.',
        'for ({ x: [sink.alias] } of items) {}',
      ].join('\n'),
      [[5, 'sink.alias']],
    ],
    [
      'a tuple-shaped iterable',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const arr: [SourceItem];',
        'for ({ x: [sink.alias] } of arr) {}',
      ].join('\n'),
      [[5, 'sink.alias']],
    ],
    [
      'a structural iterator through its next().value fallback',
      [
        "import { target } from './target.js';",
        'class NoArgIterator {',
        '  [Symbol.iterator](): { next(): { value: unknown; done: boolean } } {',
        '    return { next: () => ({ value: undefined as unknown, done: false }) };',
        '  }',
        '}',
        'declare const sink: { alias: unknown };',
        'declare const iterable: NoArgIterator;',
        '// @ts-expect-error The structural iterator value is intentionally unknown.',
        'for ({ x: [sink.alias] } of iterable) {}',
      ].join('\n'),
      [[10, 'sink.alias']],
    ],
    [
      'a mismatched numeric index signature through its iterator',
      [
        "import { target } from './target.js';",
        'type TargetShape = { x: [typeof target] };',
        'class MismatchIndex {',
        '  [n: number]: string;',
        '  [Symbol.iterator](): Iterator<TargetShape> {',
        '    return { next: (): IteratorResult<TargetShape> => { throw new Error(); } };',
        '  }',
        '}',
        'declare const sink: { alias: unknown };',
        'declare const iterable: MismatchIndex;',
        'for ({ x: [sink.alias] } of iterable) {}',
      ].join('\n'),
      [[11, 'sink.alias']],
    ],
    [
      'a non-generic named iterator class through its next().value fallback',
      [
        "import { target } from './target.js';",
        'type TargetShape = { x: [typeof target] };',
        'class ConcreteIterator {',
        '  next(): { value: TargetShape; done: false } { throw new Error(); }',
        '}',
        'class Custom {',
        '  [Symbol.iterator](): ConcreteIterator { return new ConcreteIterator(); }',
        '}',
        'declare const sink: { alias: unknown };',
        'declare const iterable: Custom;',
        'for ({ x: [sink.alias] } of iterable) {}',
      ].join('\n'),
      [[11, 'sink.alias']],
    ],
  ] as const)('reports a for-of assignment head from %s', async (_name, source, unsafeReferences) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], unsafeReferences);
      expectUnsafeReferenceNodes(scan, unsafeReferences.map(([, marker]) => (
        [marker, ts.SyntaxKind.PropertyAccessExpression] as const
      )));
    });
  });

  test('propagates an any source through a plain assignment array-literal property', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare const source: any;',
      'let alias: unknown;',
      '({ x: [alias] } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[4, 'alias']]);
    });
  });

  test('composes a wrapped array element with an any[] for-of assignment head', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare const sink: { alias: unknown };',
      'declare const arr: any[];',
      'for ({ x: [(sink.alias)] } of arr) {}',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[4, 'sink.alias']]);
      expectUnsafeReferenceNodes(scan, [['sink.alias', ts.SyntaxKind.PropertyAccessExpression]]);
    });
  });

  test.each([
    [
      'a concrete iterable whose slot is unrelated',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [string] };',
        'declare const sink: { alias: unknown };',
        'declare const arr: SourceItem[];',
        'for ({ x: [sink.alias] } of arr) {}',
      ].join('\n'),
    ],
    [
      'an iterable cast to a safe outer type',
      [
        "import { target } from './target.js';",
        'type SafeItem = { x: [string] };',
        'declare const sink: { alias: unknown };',
        'declare const unsafeItems: any[];',
        'for ({ x: [sink.alias] } of (unsafeItems as unknown as SafeItem[])) {}',
      ].join('\n'),
    ],
  ] as const)('keeps a for-of assignment head from reporting when %s', async (_name, source) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], []);
    });
  });

  test('retains the existing for-await-of declaration-head behavior for AsyncIterable<any>', async () => {
    const source = [
      "import { target } from './target.js';",
      'declare const items: AsyncIterable<any>;',
      'async function run(): Promise<void> {',
      '  for await (const { x: [alias] } of items) { void alias; }',
      '}',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[4, 'alias']]);
      expectUnsafeReferenceNodes(scan, [['alias', ts.SyntaxKind.Identifier]]);
    });
  });

  test.each([
    [
      'an AsyncIterable<any> assignment head',
      [
        "import { target } from './target.js';",
        'declare const sink: { alias: unknown };',
        'declare const items: AsyncIterable<any>;',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
      [[5, 'sink.alias']],
    ],
    [
      'a precise AsyncIterable source',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const items: AsyncIterable<SourceItem>;',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
      [[6, 'sink.alias']],
    ],
    [
      'a sync-only Iterable<any> fallback',
      [
        "import { target } from './target.js';",
        'declare const sink: { alias: unknown };',
        'declare const items: Iterable<any>;',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
      [[5, 'sink.alias']],
    ],
    [
      'a sync-only Set<SourceItem> fallback',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const items: Set<SourceItem>;',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
      [[6, 'sink.alias']],
    ],
    [
      'an array of target-bearing promises',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const promises: Promise<SourceItem>[];',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of promises) {}',
        '}',
      ].join('\n'),
      [[6, 'sink.alias']],
    ],
    [
      'an Iterable of target-bearing promises',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const promises: Iterable<Promise<SourceItem>>;',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of promises) {}',
        '}',
      ].join('\n'),
      [[6, 'sink.alias']],
    ],
    [
      'the async protocol of a dual-protocol iterable',
      [
        "import { target } from './target.js';",
        'type SourceItem = { x: [typeof target] };',
        'type Unrelated = { x: [string] };',
        'declare const sink: { alias: unknown };',
        'declare const items: { [Symbol.iterator](): Iterator<Unrelated>; [Symbol.asyncIterator](): AsyncIterator<SourceItem> };',
        'async function run(): Promise<void> {',
        '  for ({ x: [sink.alias] } of items) {}',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
      [[8, 'sink.alias']],
    ],
  ] as const)('reports a for-await-of assignment head from %s', async (_name, source, unsafeReferences) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], unsafeReferences);
      expectUnsafeReferenceNodes(scan, unsafeReferences.map(([, marker]) => (
        [marker, ts.SyntaxKind.PropertyAccessExpression] as const
      )));
    });
  });

  test.each([
    [
      'a precise unrelated AsyncIterable source',
      [
        "import { target } from './target.js';",
        'type Unrelated = { x: [string] };',
        'declare const sink: { alias: unknown };',
        'declare const items: AsyncIterable<Unrelated>;',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
    ],
    [
      'a sync-only Set<Unrelated> fallback',
      [
        "import { target } from './target.js';",
        'type Unrelated = { x: [string] };',
        'declare const sink: { alias: unknown };',
        'declare const items: Set<Unrelated>;',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
    ],
    [
      'an array of unrelated promises',
      [
        "import { target } from './target.js';",
        'type Unrelated = { x: [string] };',
        'declare const sink: { alias: unknown };',
        'declare const promises: Promise<Unrelated>[];',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of promises) {}',
        '}',
      ].join('\n'),
    ],
    [
      'a structural async iterator with a Promise-wrapped result',
      [
        "import { target } from './target.js';",
        'type TargetShape = { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        'declare const items: { [Symbol.asyncIterator](): { next(): Promise<{ value: TargetShape; done: boolean }> } };',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
    ],
    [
      'a mixed-protocol union source',
      [
        "import { target } from './target.js';",
        'declare const sink: { alias: unknown };',
        'declare const items: AsyncIterable<{ x: [typeof target] }> | Iterable<{ x: [string] }>;',
        'async function run(): Promise<void> {',
        '  for await ({ x: [sink.alias] } of items) {}',
        '}',
      ].join('\n'),
    ],
    [
      'a custom generic iterator whose yielded type is its second parameter',
      [
        "import { target } from './target.js';",
        'type TargetShape = { x: [typeof target] };',
        'class Weird<A, B> implements Iterator<B> {',
        '  next(): IteratorResult<B> { throw new Error(); }',
        '}',
        'declare const sink: { alias: unknown };',
        'declare const items: { [Symbol.iterator](): Weird<string, TargetShape> };',
        'for ({ x: [sink.alias] } of items) {}',
      ].join('\n'),
    ],
  ] as const)('keeps a for-await-of assignment head from reporting for %s', async (_name, source) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], []);
    });
  });

  test.each([
    [
      'a declaration head',
      [
        "import { target } from './target.js';",
        'declare const arr: any[];',
        'for (const { x: [alias] } of arr) {}',
      ].join('\n'),
      [[3, 'alias']],
    ],
    [
      'a comma-expression plain assignment',
      [
        "import { target } from './target.js';",
        'declare function sideEffect(): void;',
        'declare const source: { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        '(sideEffect(), ({ x: [sink.alias] } = source));',
      ].join('\n'),
      [[5, '(sideEffect(),'], [5, 'sink.alias']],
    ],
  ] as const)('retains the existing nested-array behavior for %s', async (_name, source, unsafeReferences) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], unsafeReferences);
    });
  });

  test('propagates a computed property name through the nested array-object fallback', async () => {
    const source = [
      "import * as api from './target.js';",
      "declare const key: 'target';",
      'declare const source: { x: [typeof api] };',
      'let alias: unknown;',
      '({ x: [{ [key]: alias }] } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[5, '[key]']]);
    });
  });

  test('propagates an any array element through the nested array-object fallback', async () => {
    const source = [
      "import * as api from './target.js';",
      'declare const source: { x: any[] };',
      'let alias: unknown;',
      '({ x: [{ target: alias }] } = source);',
    ].join('\n');
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], [[4, 'alias']]);
    });
  });

  test.each([
    [
      'an array nested inside another array literal',
      [
        "import { target } from './target.js';",
        'declare const source: { x: [[typeof target]] };',
        'let alias: unknown;',
        '({ x: [[alias]] } = source);',
      ].join('\n'),
    ],
    [
      'a direct array-literal spread element',
      [
        "import { target } from './target.js';",
        'declare const source: { x: typeof target[] };',
        'let rest: unknown[];',
        '({ x: [...rest] } = source);',
      ].join('\n'),
    ],
    [
      'a nested object-rest target inside an array-literal element',
      [
        "import * as api from './target.js';",
        'declare const source: { x: [typeof api] };',
        'let rest: unknown;',
        '({ x: [{ ...rest }] } = source);',
      ].join('\n'),
    ],
    [
      'a defaulted bare array element',
      [
        "import { target } from './target.js';",
        'declare const source: { x: [typeof target] };',
        'declare const sink: { alias: unknown };',
        '({ x: [sink.alias = undefined] } = source);',
      ].join('\n'),
    ],
    [
      'a defaulted nested-object array element',
      [
        "import * as api from './target.js';",
        'declare const source: { x: [typeof api] };',
        'let alias: unknown;',
        'declare const fallback: { target: unknown };',
        '({ x: [{ target: alias } = fallback] } = source);',
      ].join('\n'),
    ],
    [
      'a plain array property-access read',
      [
        "import { target } from './target.js';",
        'declare const sink: { alias: unknown };',
        'const values: unknown[] = [sink.alias];',
        'void values;',
      ].join('\n'),
    ],
    [
      'a wrapped bare top-level array assignment target',
      [
        "import { target } from './target.js';",
        'declare const source: unknown;',
        'declare const sink: { alias: unknown };',
        '[(sink.alias)] = (source as [typeof target]);',
      ].join('\n'),
    ],
    [
      'a plain array element-access read outside the H3a-1 index-signature path',
      [
        "import { target } from './target.js';",
        'declare const numericValues: number[];',
        'const values: unknown[] = [numericValues[0]];',
        'void values;',
      ].join('\n'),
    ],
  ] as const)('keeps %s outside both inventories', async (_name, source) => {
    await withCaller(source, (scan, names) => {
      expectScan(scan, names['src/caller.ts'] ?? '', source, [], []);
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
