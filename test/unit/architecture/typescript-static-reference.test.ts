import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { createStaticReferenceResolver } from '../../../tools/typescript-static-reference.js';

async function withProgram(
  files: Readonly<Record<string, string>>,
  assertion: (program: ts.Program, names: Readonly<Record<string, string>>) => void,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-static-reference-'));
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

function sourceFile(program: ts.Program, fileName: string): ts.SourceFile {
  const source = program.getSourceFile(fileName);
  if (source === undefined) throw new Error(`Missing source file ${fileName}.`);
  return source;
}

function variableExpression(source: ts.SourceFile, name: string): ts.Expression {
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap(({ declarationList }) => [...declarationList.declarations])
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  if (declaration?.initializer === undefined) throw new Error(`Missing initializer for ${name}.`);
  return declaration.initializer;
}

function variableIdentifier(source: ts.SourceFile, name: string): ts.Identifier {
  const declaration = source.statements
    .filter(ts.isVariableStatement)
    .flatMap(({ declarationList }) => [...declarationList.declarations])
    .find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name);
  if (declaration === undefined || !ts.isIdentifier(declaration.name)) throw new Error(`Missing variable ${name}.`);
  return declaration.name;
}

function parameterIdentifier(source: ts.SourceFile, name: string): ts.Identifier {
  let parameter: ts.ParameterDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (parameter !== undefined) return;
    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      parameter = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (parameter === undefined || !ts.isIdentifier(parameter.name)) throw new Error(`Missing parameter ${name}.`);
  return parameter.name;
}

function exportedDeclaration(checker: ts.TypeChecker, source: ts.SourceFile, name: string): ts.Declaration {
  const module = checker.getSymbolAtLocation(source);
  const exported = module === undefined ? undefined : checker.getExportsOfModule(module).find((symbol) => symbol.name === name);
  const resolved = exported !== undefined && exported.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(exported)
    : exported;
  const declaration = resolved?.declarations?.[0];
  if (declaration === undefined) throw new Error(`Missing exported declaration ${name}.`);
  return declaration;
}

describe('createStaticReferenceResolver()', () => {
  test.each([
    ['a raw string literal', "const resolved = 'target';", 'resolved', ['target']],
    ['a raw numeric literal', 'const resolved = 42;', 'resolved', ['42']],
    ['a nested transparent wrapper around a literal', "const resolved = ((('target' as const)!));", 'resolved', ['target']],
  ])('resolves %s as a finite property key', async (_name, source, variable, expected) => {
    await withProgram({ 'src/synthetic.ts': source }, (program, names) => {
      const resolver = createStaticReferenceResolver(program.getTypeChecker());
      expect(resolver.resolvePropertyKey(variableExpression(sourceFile(program, names['src/synthetic.ts'] ?? ''), variable))).toEqual(expected);
    });
  });

  test.each([
    ['a checker-known literal type', "declare const key: 'target';", 'key', ['target']],
    ['a wholly literal finite union', "declare const key: 'target' | 'other';", 'key', ['target', 'other']],
    ['a wholly literal numeric union', 'declare const key: 1 | 2;', 'key', ['1', '2']],
  ])('resolves %s as finite property keys', async (_name, source, variable, expected) => {
    await withProgram({ 'src/synthetic.ts': source }, (program, names) => {
      const resolver = createStaticReferenceResolver(program.getTypeChecker());
      const namesForKey = resolver.resolvePropertyKey(variableIdentifier(sourceFile(program, names['src/synthetic.ts'] ?? ''), variable));
      expect(namesForKey).toHaveLength(expected.length);
      expect(namesForKey).toEqual(expect.arrayContaining(expected));
    });
  });

  test('treats a literal union with a non-literal member as a dynamic key', async () => {
    await withProgram({ 'src/synthetic.ts': "declare const key: 'target' | number;" }, (program, names) => {
      const checker = program.getTypeChecker();
      const resolver = createStaticReferenceResolver(checker);
      const key = variableIdentifier(sourceFile(program, names['src/synthetic.ts'] ?? ''), 'key');
      const keyType = checker.getTypeAtLocation(key);
      expect(keyType.isUnion()).toBe(true);
      const unionType = keyType as ts.UnionType;
      expect(unionType.types.some((member) => Boolean(member.flags & ts.TypeFlags.StringLiteral))).toBe(true);
      expect(unionType.types.some((member) => Boolean(member.flags & ts.TypeFlags.Number))).toBe(true);
      expect(resolver.resolvePropertyKey(key)).toBeUndefined();
    });
  });

  test.each([
    ['a non-literal identifier', 'declare const key: string;', 'key', true],
    ['a template literal with a substitution', 'declare const suffix: string; const key = `target-${suffix}`;', 'key', true],
    ['a call expression with a non-literal return type', 'declare function createKey(): string; const key = createKey();', 'key', false],
  ])('treats %s as a dynamic key', async (_name, source, variable, useIdentifier) => {
    await withProgram({ 'src/synthetic.ts': source }, (program, names) => {
      const resolver = createStaticReferenceResolver(program.getTypeChecker());
      const file = sourceFile(program, names['src/synthetic.ts'] ?? '');
      const expression = useIdentifier ? variableIdentifier(file, variable) : variableExpression(file, variable);
      expect(resolver.resolvePropertyKey(expression)).toBeUndefined();
    });
  });

  test('resolves a call expression with a literal return type as a finite property key', async () => {
    await withProgram({ 'src/synthetic.ts': "function createKey(): 'target' { return 'target'; } const key = createKey();" }, (program, names) => {
      const resolver = createStaticReferenceResolver(program.getTypeChecker());
      expect(resolver.resolvePropertyKey(variableExpression(sourceFile(program, names['src/synthetic.ts'] ?? ''), 'key'))).toEqual(['target']);
    });
  });

  test('resolves a type-parameter key through its finite literal constraint', async () => {
    await withProgram({ 'src/synthetic.ts': "function use<K extends 'target' | 'other'>(key: K): void { void key; }" }, (program, names) => {
      const resolver = createStaticReferenceResolver(program.getTypeChecker());
      const namesForKey = resolver.resolvePropertyKey(parameterIdentifier(sourceFile(program, names['src/synthetic.ts'] ?? ''), 'key'));
      expect(namesForKey).toHaveLength(2);
      expect(namesForKey).toEqual(expect.arrayContaining(['target', 'other']));
    });
  });

  test('treats a circular constraint chain as a dynamic key without hanging', async () => {
    await withProgram({ 'src/synthetic.ts': "function use<T extends { key: T }>(key: T['key']): void { void key; }" }, (program, names) => {
      const resolver = createStaticReferenceResolver(program.getTypeChecker());
      expect(resolver.resolvePropertyKey(parameterIdentifier(sourceFile(program, names['src/synthetic.ts'] ?? ''), 'key'))).toBeUndefined();
    });
  });

  test.each([
    ['an identifier that resolves to the target', 'exact', 'exactIdentifier'],
    ['an identifier that resolves to another declaration', 'none', 'otherIdentifier'],
    ['a target property access', 'exact', 'exactProperty'],
    ['a non-target property access', 'none', 'noneProperty'],
    ['a target element access', 'exact', 'exactElement'],
    ['a finite ambiguous element access', 'potential', 'potentialElement'],
    ['a non-target element access', 'none', 'noneElement'],
    ['a wrapped target property access', 'exact', 'wrappedReference'],
    ['a dynamic element access on an open string-index receiver', 'potential', 'closedDynamicElement'],
    ['a dot access on an open string-index receiver', 'potential', 'openIndexDot'],
    ['a cast-hidden dot receiver', 'potential', 'castHiddenDot'],
    ['a cast-hidden element receiver', 'potential', 'castHiddenElement'],
    ['a double-cast-hidden receiver', 'potential', 'doubleCastHidden'],
  ] as const)('classifies %s as %s', async (_name, kind, variable) => {
    await withProgram({
      'src/target.ts': 'export const target = (): void => undefined;',
      'src/synthetic.ts': [
        "import { target } from './target.js';",
        'const other = (): void => undefined;',
        'const values = { target, other };',
        'declare const selected: \'target\' | \'other\';',
        'declare const dynamic: string;',
        'declare const closed: Record<string, () => void>;',
        'const exactIdentifier = target;',
        'const otherIdentifier = other;',
        'const exactProperty = values.target;',
        'const noneProperty = values.other;',
        "const exactElement = values['target'];",
        'const potentialElement = values[selected];',
        "const noneElement = values['other'];",
        'const wrappedReference = ((values.target)! as typeof target);',
        'const closedDynamicElement = closed[dynamic];',
        'const openIndexDot = closed.target;',
        "const castHiddenDot = (closed as unknown as { target: string }).target;",
        "const castHiddenElement = (closed as unknown as { target: string })['target'];",
        "const doubleCastHidden = ((closed as unknown) as { target: string }).target;",
      ].join('\n'),
    }, (program, names) => {
      const checker = program.getTypeChecker();
      const target = exportedDeclaration(checker, sourceFile(program, names['src/target.ts'] ?? ''), 'target');
      const resolver = createStaticReferenceResolver(checker);
      const expression = variableExpression(sourceFile(program, names['src/synthetic.ts'] ?? ''), variable);
      expect(resolver.resolvePropertyReference(expression, (symbol) => symbol.declarations?.includes(target) ?? false)).toEqual({ kind });
    });
  });

  test.each([
    ['an empty finite candidate set', 'explicit', [], 'string', 'none'],
    ['a finite candidate set with one target and one non-target', 'explicit', ['target', 'other'], 'string', 'potential'],
    ['a string key without an explicit property on a string-index receiver', 'stringIndexed', ['missing'], 'string', 'potential'],
    ['a number key without an explicit property on a number-index receiver', 'numberIndexed', ['1'], 'number', 'potential'],
    ['a missing property on a receiver with no applicable index signature', 'closed', ['missing'], 'string', 'none'],
    ['a string-only key on a receiver with only a number index signature', 'numberIndexed', ['target'], 'string', 'none'],
  ] as const)('classifies %s through resolvePropertySelection()', async (_name, receiver, candidates, applicability, kind) => {
    await withProgram({
      'src/target.ts': 'export const target = (): void => undefined;',
      'src/synthetic.ts': [
        "import { target } from './target.js';",
        'const other = (): void => undefined;',
        'const explicit = { target, other };',
        'declare const stringIndexed: Record<string, typeof target>;',
        'declare const numberIndexed: { [key: number]: typeof target };',
        'declare const closed: { other: typeof other };',
      ].join('\n'),
    }, (program, names) => {
      const checker = program.getTypeChecker();
      const target = exportedDeclaration(checker, sourceFile(program, names['src/target.ts'] ?? ''), 'target');
      const resolver = createStaticReferenceResolver(checker);
      const file = sourceFile(program, names['src/synthetic.ts'] ?? '');
      const receiverType = checker.getTypeAtLocation(variableIdentifier(file, receiver));

      expect(resolver.resolvePropertySelection(
        receiverType,
        candidates,
        applicability,
        (symbol) => symbol.declarations?.includes(target) ?? false,
      )).toEqual({ kind });
    });
  });

  test.each([
    ['an any-typed property receiver', 'anyProperty'],
    ['an any-typed element receiver', 'anyElement'],
    ['an unknown-typed property receiver', 'unknownProperty'],
    ['an unknown-typed element receiver', 'unknownElement'],
  ])('classifies %s as a potential reference', async (_name, variable) => {
    await withProgram({
      'src/target.ts': 'export const target = (): void => undefined;',
      'src/synthetic.ts': [
        'declare const anyReceiver: any;',
        'declare const unknownReceiver: unknown;',
        'const anyProperty = anyReceiver.target;',
        "const anyElement = anyReceiver['target'];",
        '// @ts-expect-error Unknown receivers do not expose properties.',
        'const unknownProperty = unknownReceiver.target;',
        '// @ts-expect-error Unknown receivers do not expose element access.',
        "const unknownElement = unknownReceiver['target'];",
      ].join('\n'),
    }, (program, names) => {
      const checker = program.getTypeChecker();
      const target = exportedDeclaration(checker, sourceFile(program, names['src/target.ts'] ?? ''), 'target');
      const resolver = createStaticReferenceResolver(checker);
      const expression = variableExpression(sourceFile(program, names['src/synthetic.ts'] ?? ''), variable);
      expect(resolver.resolvePropertyReference(expression, (symbol) => symbol.declarations?.includes(target) ?? false)).toEqual({ kind: 'potential' });
    });
  });

  test.each([
    [undefined, 'target', true],
    [['target', 'other'], 'target', true],
    [['other'], 'target', false],
    [[], 'target', false],
  ] as const)('reports whether key candidates may select the target', (names, target, expected) => {
    const program = ts.createProgram({ rootNames: [], options: { noEmit: true, target: ts.ScriptTarget.ES2023 } });
    const resolver = createStaticReferenceResolver(program.getTypeChecker());
    expect(resolver.propertyKeyMaySelect(names, target)).toBe(expected);
  });

  test.each([
    ['a renamed import', 'src/renamed.ts'],
    ['a two-hop re-export import', 'src/two-hop.ts'],
  ])('resolves the checker alias chain for %s', async (_name, file) => {
    await withProgram({
      'src/base.ts': 'export const target = 1;',
      'src/one.ts': "export { target as intermediate } from './base.js';",
      'src/two.ts': "export { intermediate as target } from './one.js';",
      'src/renamed.ts': "import { target as renamed } from './base.js'; export const value = renamed;",
      'src/two-hop.ts': "import { target } from './two.js'; export const value = target;",
    }, (program, names) => {
      const checker = program.getTypeChecker();
      const resolver = createStaticReferenceResolver(checker);
      const original = exportedDeclaration(checker, sourceFile(program, names['src/base.ts'] ?? ''), 'target');
      const symbol = checker.getSymbolAtLocation(variableExpression(sourceFile(program, names[file] ?? ''), 'value'));
      expect(resolver.resolveAliasedSymbol(symbol)?.declarations).toContain(original);
    });
  });

  test('preserves a non-alias symbol and an absent symbol', async () => {
    await withProgram({ 'src/synthetic.ts': 'const value = 1;' }, (program, names) => {
      const checker = program.getTypeChecker();
      const resolver = createStaticReferenceResolver(checker);
      const symbol = checker.getSymbolAtLocation(variableIdentifier(sourceFile(program, names['src/synthetic.ts'] ?? ''), 'value'));
      expect(resolver.resolveAliasedSymbol(symbol)).toBe(symbol);
      expect(resolver.resolveAliasedSymbol(undefined)).toBeUndefined();
    });
  });

  test('handles a declarationless symbol from an empty program without throwing', () => {
    const program = ts.createProgram({ rootNames: [], options: { noEmit: true, target: ts.ScriptTarget.ES2023 } });
    const resolver = createStaticReferenceResolver(program.getTypeChecker());
    const declarationless = { flags: ts.SymbolFlags.Function, name: 'orphan' } as ts.Symbol;
    expect(resolver.resolveAliasedSymbol(declarationless)).toBe(declarationless);
  });
});
