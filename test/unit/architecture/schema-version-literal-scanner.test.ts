import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { scanSchemaVersionLiteralViolations, type SchemaVersionLiteralViolation } from '../../../tools/schema-version-literal-scanner.js';

const authority = 'export const PLAN_SCHEMA_VERSION = 2 as const;\nexport const GROUNDING_SCHEMA_VERSION = 1 as const;';

interface ScanResult {
  readonly callerFileName: string;
  readonly violations: readonly SchemaVersionLiteralViolation[];
}

async function scanWithCaller(source: string, schemaSource = authority, extra: Readonly<Record<string, string>> = {}): Promise<ScanResult> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-schema-version-scanner-'));
  const schema = join(root, 'src/core/ir/schema.ts');
  const caller = join(root, 'src/usecases/synthetic.ts');
  const files = Object.fromEntries(Object.keys(extra).map((path) => [path, join(root, path)]));
  try {
    await Promise.all([
      mkdir(dirname(schema), { recursive: true }), mkdir(dirname(caller), { recursive: true }),
      ...Object.values(files).map((fileName) => mkdir(dirname(fileName), { recursive: true })),
    ]);
    await Promise.all([writeFile(schema, schemaSource), writeFile(caller, source), ...Object.entries(extra).map(([path, text]) => writeFile(files[path] ?? '', text))]);
    const program = ts.createProgram({ rootNames: [schema, caller, ...Object.values(files)], options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, strict: true, target: ts.ScriptTarget.ES2023 } });
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(program.getSemanticDiagnostics()).toEqual([]);
    return { callerFileName: caller, violations: scanSchemaVersionLiteralViolations(program, schema) };
  } finally { await rm(root, { force: true, recursive: true }); }
}

async function scan(source: string, schemaSource = authority, extra: Readonly<Record<string, string>> = {}): Promise<readonly SchemaVersionLiteralViolation[]> {
  return (await scanWithCaller(source, schemaSource, extra)).violations;
}

async function expectOneFromSource(source: string, coordinate: Readonly<Pick<SchemaVersionLiteralViolation, 'line' | 'column'>>): Promise<void> {
  const result = await scanWithCaller(source);
  expect(result.violations).toEqual([{ fileName: result.callerFileName, ...coordinate }]);
}

function expectOne(result: readonly SchemaVersionLiteralViolation[], coordinate: Readonly<Pick<SchemaVersionLiteralViolation, 'line' | 'column'>>): void {
  expect(result).toEqual([expect.objectContaining({ fileName: expect.stringMatching(/\/src\/usecases\/synthetic\.ts$/), ...coordinate })]);
}

describe('scanSchemaVersionLiteralViolations()', () => {
  test.each([
    ['parenthesized literal', 'const value = { schemaVersion: (2) };'],
    ['as-const literal', 'const value = { schemaVersion: (2 as const) };'],
    ['type assertion', 'const value = { schemaVersion: (2 as number) };'],
    ['signed numeric literal', 'const value = { schemaVersion: -2 };'],
    ['quoted property name', 'const value = { "schemaVersion": 2 };', 17],
    ['computed property name', 'const value = { ["schemaVersion"]: 2 };', 17],
    ['non-null asserted literal', 'const value = { schemaVersion: 2! };'],
    ['shorthand numeric property', 'const schemaVersion = 2; const value = { schemaVersion };'],
    ['class property', 'class Value { schemaVersion = 2; }'],
    ['class computed property', 'class Value { ["schemaVersion"] = 2; }', 15],
    ['local numeric indirection', 'const local = 2; const value = { schemaVersion: local };'],
    ['arithmetic', 'const value = { schemaVersion: 1 + 1 };'],
    ['Number call', 'const x: number = 1; const value = { schemaVersion: Number(x) };'],
    ['numeric conditional union', 'declare const cond: boolean; const value = { schemaVersion: cond ? 1 : 2 };'],
    ['mixed numeric/string union', "const value: number | string = Math.random() ? 1 : 'one'; const result = { schemaVersion: value };"],
    ['any source', 'declare const value: any; const result = { schemaVersion: value };'],
    ['unknown source', 'declare const value: unknown; const result = { schemaVersion: value };'],
  ])('rejects a %s source', async (_name, source, column?: number) => { await expectOneFromSource(source, { line: 1, column: column ?? source.lastIndexOf('schemaVersion') + 1 }); });

  test.each([
    ['=', 'obj.schemaVersion = 2;'], ['+=', 'obj.schemaVersion += 1;'], ['-=', 'obj.schemaVersion -= 1;'], ['*=', 'obj.schemaVersion *= 1;'], ['/=', 'obj.schemaVersion /= 1;'], ['%=', 'obj.schemaVersion %= 1;'], ['**=', 'obj.schemaVersion **= 1;'], ['<<=', 'obj.schemaVersion <<= 1;'], ['>>=', 'obj.schemaVersion >>= 1;'], ['>>>=', 'obj.schemaVersion >>>= 1;'], ['&=', 'obj.schemaVersion &= 1;'], ['|=', 'obj.schemaVersion |= 1;'], ['^=', 'obj.schemaVersion ^= 1;'], ['&&=', 'obj.schemaVersion &&= 1;'], ['||=', 'obj.schemaVersion ||= 1;'], ['??=', 'obj.schemaVersion ??= 1;'],
  ])('rejects non-authority %s assignment', async (_operator, assignment) => { expectOne(await scan(["import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';", `let obj: { schemaVersion: number } = { schemaVersion: PLAN_SCHEMA_VERSION }; ${assignment}`].join('\n')), { line: 2, column: 78 }); });

  test.each([
    ['==', 'plan.schemaVersion == 2'], ['!=', 'plan.schemaVersion != 2'], ['===', 'plan.schemaVersion === 2'], ['!==', 'plan.schemaVersion !== 2'], ['<', 'plan.schemaVersion < 2'], ['<=', 'plan.schemaVersion <= 2'], ['>', 'plan.schemaVersion > 2'], ['>=', 'plan.schemaVersion >= 2'],
  ])('rejects both operand directions of %s comparison', async (_operator, expression) => {
    const reversed = expression.replace('plan.schemaVersion', '2').replace(/ 2$/, ' plan.schemaVersion');
    const callerSource = `const plan = { schemaVersion: PLAN_SCHEMA_VERSION }; void (${expression}); void (${reversed});`;
    const source = ["import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';", callerSource].join('\n');
    const result = await scanWithCaller(source);
    expect(result.violations).toEqual([
      { fileName: result.callerFileName, line: 2, column: callerSource.indexOf('plan.schemaVersion', callerSource.indexOf('void')) + 1 },
      { fileName: result.callerFileName, line: 2, column: callerSource.lastIndexOf('plan.schemaVersion') + 1 },
    ]);
  });

  test('recognizes computed schemaVersion assignment and comparison sinks', async () => {
    expectOne(await scan(["import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';", "let obj = { schemaVersion: PLAN_SCHEMA_VERSION }; obj['schemaVersion'] = 2;"].join('\n')), { line: 2, column: 51 });
    expectOne(await scan(["import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';", "const obj = { schemaVersion: PLAN_SCHEMA_VERSION }; void (2 === obj['schemaVersion']);"].join('\n')), { line: 2, column: 65 });
  });

  test('recognizes transparent wrappers around computed keys and schemaVersion accesses', async () => {
    const callerSource = 'const plan = { schemaVersion: PLAN_SCHEMA_VERSION }; const invalid = { [("schemaVersion" as const)]: 2 }; void ((plan.schemaVersion) !== 2); void (2 !== (plan[("schemaVersion" as const)]));';
    const source = [
      "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';",
      callerSource,
    ].join('\n');
    const result = await scanWithCaller(source);
    expect(result.violations).toEqual([
      { fileName: result.callerFileName, line: 2, column: callerSource.indexOf('[("schemaVersion"') + 1 },
      { fileName: result.callerFileName, line: 2, column: callerSource.indexOf('(plan.schemaVersion)') + 1 },
      { fileName: result.callerFileName, line: 2, column: callerSource.lastIndexOf('(plan[("schemaVersion"') + 1 },
    ]);
  });

  test('rejects both direct destructuring-default forms and computed binding keys', async () => {
    expectOne(await scan('declare const value: { schemaVersion?: number }; const { schemaVersion = 2 } = value;'), { line: 1, column: 58 });
    expectOne(await scan('let schemaVersion: number; declare const value: { schemaVersion?: number }; ({ schemaVersion = 2 } = value);'), { line: 1, column: 80 });
    expectOne(await scan('declare const value: { schemaVersion?: number }; const { ["schemaVersion"]: schemaVersion = 2 } = value;'), { line: 1, column: 58 });
  });

  test('rejects an assignment-pattern default to a canonical authority', async () => {
    const source = [
      "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';",
      'declare const optional: { schemaVersion?: number }; let assigned: number;',
      '({ schemaVersion: assigned = PLAN_SCHEMA_VERSION } = optional);',
    ].join('\n');
    await expectOneFromSource(source, { line: 3, column: 4 });
  });

  test('rejects an assignment-pattern default to a numeric literal', async () => {
    const source = [
      'declare const optional: { schemaVersion?: number }; let assigned: number;',
      '({ schemaVersion: assigned = 3 } = optional);',
    ].join('\n');
    await expectOneFromSource(source, { line: 2, column: 4 });
  });

  test('rejects an assignment-pattern default to schemaVersion propagation', async () => {
    const source = [
      "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';",
      'const from = { schemaVersion: PLAN_SCHEMA_VERSION }; declare const optional: { schemaVersion?: number }; let assigned: number;',
      '({ schemaVersion: assigned = from.schemaVersion } = optional);',
    ].join('\n');
    await expectOneFromSource(source, { line: 3, column: 4 });
  });

  test('allows a direct non-renamed assignment destructuring default to a canonical authority', async () => {
    const source = [
      "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';",
      'declare const optional: { schemaVersion?: number }; let schemaVersion: number;',
      '({ schemaVersion = PLAN_SCHEMA_VERSION } = optional);',
    ].join('\n');
    expect(await scan(source)).toEqual([]);
  });

  test('allows a renamed binding-element default to a canonical authority', async () => {
    const source = [
      "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';",
      'declare const optional: { schemaVersion?: number };',
      'const { schemaVersion: assigned = PLAN_SCHEMA_VERSION } = optional;',
    ].join('\n');
    expect(await scan(source)).toEqual([]);
  });

  test('allows a string assignment-pattern default through the ordinary type gate', async () => {
    const source = [
      'declare const optional: { schemaVersion?: string }; let assigned: string;',
      "({ schemaVersion: assigned = '3.0' } = optional);",
    ].join('\n');
    expect(await scan(source)).toEqual([]);
  });

  test.each([
    ['namespace authority', "import * as Schema from '../core/ir/schema.js'; const value = { schemaVersion: Schema.PLAN_SCHEMA_VERSION };", {}],
    ['barrel authority', "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema-barrel.js'; const value = { schemaVersion: PLAN_SCHEMA_VERSION };", { 'src/core/ir/schema-barrel.ts': "export { PLAN_SCHEMA_VERSION } from './schema.js';" }],
    ['multi-hop barrel authority', "import { PLAN_SCHEMA_VERSION } from '../core/ir/two.js'; const value = { schemaVersion: PLAN_SCHEMA_VERSION };", { 'src/core/ir/one.ts': "export { PLAN_SCHEMA_VERSION } from './schema.js';", 'src/core/ir/two.ts': "export { PLAN_SCHEMA_VERSION } from './one.js';" }],
  ])('allows %s', async (_name, source, extra) => { expect(await scan(source, authority, extra)).toEqual([]); });

  test('allows a genuine authority constant through a transparent cast', async () => {
    const source = [
      "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';",
      'const value = { schemaVersion: (PLAN_SCHEMA_VERSION as typeof PLAN_SCHEMA_VERSION) };',
    ].join('\n');
    expect(await scan(source)).toEqual([]);
  });

  test('allows direct authorities and schemaVersion propagation in every sink form', async () => {
    const source = [
      "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';",
      'const from = { schemaVersion: PLAN_SCHEMA_VERSION }; const obj: { schemaVersion: number } = { schemaVersion: PLAN_SCHEMA_VERSION };',
      'const property = { schemaVersion: PLAN_SCHEMA_VERSION }; class Value { schemaVersion = from.schemaVersion; }',
      'obj.schemaVersion = PLAN_SCHEMA_VERSION; obj.schemaVersion += PLAN_SCHEMA_VERSION;',
      'obj.schemaVersion = from.schemaVersion; obj.schemaVersion += from.schemaVersion;',
      'void (obj.schemaVersion === PLAN_SCHEMA_VERSION); void (from.schemaVersion !== obj.schemaVersion);',
      'declare const optional: { schemaVersion?: number }; const { schemaVersion: declared = from.schemaVersion } = optional;',
    ].join('\n');
    expect(await scan(source)).toEqual([]);
  });

  test('allows a string sink and declaration-only non-value positions', async () => {
    expect(await scan("const report = { schemaVersion: '3.0' as const }; interface I { schemaVersion: number; } type T = { schemaVersion: number }; declare class D { schemaVersion: number; }")).toEqual([]);
  });

  test('rejects a canonical-authority-derived local re-bind', async () => {
    expectOne(await scan("import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js'; const local = PLAN_SCHEMA_VERSION; const value = { schemaVersion: local };"), { line: 1, column: 112 });
  });

  test.each([
    ['T extends number', 'function value<T extends number>(schemaVersion: T) { return { schemaVersion }; }'],
    ['T extends number | string', 'function value<T extends number | string>(schemaVersion: T) { return { schemaVersion }; }'],
    ['an unconstrained T', 'function value<T>(schemaVersion: T) { return { schemaVersion }; }'],
  ])('rejects %s through the type gate without hanging', async (_name, source) => { await expectOneFromSource(source, { line: 1, column: source.lastIndexOf('schemaVersion') + 1 }); });

  test('allows non-numeric and recursively constrained generic parameters without hanging', async () => {
    expect(await scan('function value<T extends string>(schemaVersion: T) { return { schemaVersion }; }')).toEqual([]);
    expect(await scan('interface Recursive<T extends Recursive<T>> { next?: T; } function value<T extends Recursive<T>>(schemaVersion: T) { return { schemaVersion }; }')).toEqual([]);
  });

  test.each([
    ['an as-any assertion', "const value = { schemaVersion: '2' as any };"],
    ['an as-unknown assertion', "const value = { schemaVersion: '2' as unknown };"],
    ['an as-unknown-as-number assertion', "const value = { schemaVersion: '2' as unknown as number };"],
  ])('rejects %s without unwrapping its asserted type', async (_name, source) => {
    await expectOneFromSource(source, { line: 1, column: source.indexOf('schemaVersion') + 1 });
  });

  test('rejects a non-null-asserted unknown source', async () => {
    const source = 'declare const value: unknown; const result = { schemaVersion: value! };';
    await expectOneFromSource(source, { line: 1, column: source.indexOf('schemaVersion') + 1 });
  });

  test.each([
    ['a parenthesized non-null assertion', 'declare const value: unknown; const result = { schemaVersion: (value!) };'],
    ['a repeated non-null assertion', 'declare const value: unknown; const result = { schemaVersion: value!! };'],
  ])('rejects %s of an unknown source', async (_name, source) => {
    await expectOneFromSource(source, { line: 1, column: source.indexOf('schemaVersion') + 1 });
  });

  test.each([
    ['a number-like constraint', "function value<T extends { v: number }>(source: T['v']) { return { schemaVersion: source }; }", true],
    ['an unresolvable constraint', "function value<T extends Record<string, unknown>, K extends string>(source: T[K]) { return { schemaVersion: source }; }", true],
    ['a circular constraint', "function value<T extends { v: T }>(source: T['v']) { return { schemaVersion: source }; }", true],
    ['a string-only constraint', "function value<T extends { v: string }>(source: T['v']) { return { schemaVersion: source }; }", false],
    ['a finite literal index parameter with only string properties', "function value<T extends Record<'a' | 'b', string>, K extends 'a' | 'b'>(source: T[K]) { return { schemaVersion: source }; }", false],
    ['a finite literal index parameter with a number-like candidate', "function value<T extends { a: string; b: number }, K extends 'a' | 'b'>(source: T[K]) { return { schemaVersion: source }; }", true],
  ])('handles IndexedAccess sources with %s', async (_name, source, rejected) => {
    const result = await scan(source);
    if (rejected) {
      expectOne(result, { line: 1, column: source.indexOf('schemaVersion') + 1 });
    } else {
      expect(result).toEqual([]);
    }
  });

  test('allows an exact namespace-bracket authority source', async () => {
    expect(await scan("import * as Schema from '../core/ir/schema.js'; const value = { schemaVersion: Schema['PLAN_SCHEMA_VERSION'] };"))
      .toEqual([]);
  });

  test.each([
    ['a union that can select an authority and another export', "import * as Schema from '../core/ir/schema.js'; declare const key: 'PLAN_SCHEMA_VERSION' | 'OTHER'; const value = { schemaVersion: Schema[key] };", true],
    ['a key narrowed to just the authority', "import * as Schema from '../core/ir/schema.js'; const key = 'PLAN_SCHEMA_VERSION' as const; const value = { schemaVersion: Schema[key] };", false],
  ])('requires exact identity for %s', async (_name, source, rejected) => {
    const schemaSource = `${authority}\nexport const OTHER = 3 as const;`;
    const result = await scan(source, schemaSource);
    if (rejected) {
      expectOne(result, { line: 1, column: source.indexOf('schemaVersion') + 1 });
    } else {
      expect(result).toEqual([]);
    }
  });

  test.each([
    ['a number-like source', 'number', true],
    ['a string-only source', 'string', false],
  ])('keeps a potential finite-union computed propagation subject to the source gate for %s', async (_name, sourceType, rejected) => {
    const source = [
      "declare const key: 'schemaVersion' | 'other';",
      `declare const source: { schemaVersion: ${sourceType}; other: ${sourceType} };`,
      'const result = { schemaVersion: source[key] };',
    ].join('\n');
    const result = await scanWithCaller(source);
    if (rejected) {
      expect(result.violations).toEqual([{
        fileName: result.callerFileName,
        line: 3,
        column: 18,
      }]);
    } else {
      expect(result.violations).toEqual([]);
    }
  });

  test('keeps a potential any-receiver computed propagation subject to the source gate', async () => {
    const source = [
      'declare const anyReceiver: any;',
      'declare const dynamicKey: string;',
      'const result = { schemaVersion: anyReceiver[dynamicKey] };',
    ].join('\n');
    const result = await scanWithCaller(source);
    expect(result.violations).toEqual([{ fileName: result.callerFileName, line: 3, column: 18 }]);
  });

  test.each([
    ['a const-bound key', "const key = 'schemaVersion' as const; const value = { [key]: 2 };"],
    ['a finite-union key', "declare const key: 'schemaVersion' | 'other'; const value = { [key]: 2 };"],
  ])('recognizes %s as a schemaVersion sink', async (_name, source) => {
    await expectOneFromSource(source, { line: 1, column: source.indexOf('[key]') + 1 });
  });

  test('does not treat a bare local schemaVersion identifier as a property access', async () => {
    expect(await scan('const schemaVersion = 2; void (schemaVersion === 2);')).toEqual([]);
  });

  test('reports exact report-node coordinates for every sink family', async () => {
    expectOne(await scan('const value = { schemaVersion: 2 };'), { line: 1, column: 17 });
    expectOne(await scan('const schemaVersion = 2; const value = { schemaVersion };'), { line: 1, column: 42 });
    expectOne(await scan(["import { PLAN_SCHEMA_VERSION } from '../core/ir/schema.js';", 'let obj = { schemaVersion: PLAN_SCHEMA_VERSION }; obj.schemaVersion = 2;'].join('\n')), { line: 2, column: 51 });
    expectOne(await scan('declare const value: { schemaVersion?: number }; const { schemaVersion = 2 } = value;'), { line: 1, column: 58 });
    expectOne(await scan('const value = { ["schemaVersion"]: 2 };'), { line: 1, column: 17 });
    expectOne(await scan('let schemaVersion: number; declare const value: { schemaVersion?: number }; ({ schemaVersion = 2 } = value);'), { line: 1, column: 80 });
  });

  test('throws for missing canonical exports, including partial schema modules', async () => {
    await expect(scan('const value = { schemaVersion: 2 };', 'export const other = 1;')).rejects.toThrow(/PLAN_SCHEMA_VERSION|GROUNDING_SCHEMA_VERSION/);
    await expect(scan('const value = { schemaVersion: 2 };', 'export const GROUNDING_SCHEMA_VERSION = 1 as const;')).rejects.toThrow(/PLAN_SCHEMA_VERSION/);
    await expect(scan('const value = { schemaVersion: 2 };', 'export const PLAN_SCHEMA_VERSION = 2 as const;')).rejects.toThrow(/GROUNDING_SCHEMA_VERSION/);
  });

  test('throws when the schema module is absent from the program', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ambercast-schema-version-scanner-missing-'));
    const caller = join(root, 'src/usecases/synthetic.ts');
    const missingSchema = join(root, 'src/core/ir/schema.ts');
    try {
      await mkdir(dirname(caller), { recursive: true });
      await writeFile(caller, 'const value = { schemaVersion: 2 };');
      const program = ts.createProgram({ rootNames: [caller], options: { noEmit: true, strict: true, target: ts.ScriptTarget.ES2023 } });
      expect(() => scanSchemaVersionLiteralViolations(program, missingSchema)).toThrow(/schema module.*schema\.ts/i);
    } finally { await rm(root, { force: true, recursive: true }); }
  });

  test('scans literal object fields inside the schema authority module too', async () => {
    expect(await scan('export {};', `${authority}\nexport const invalid = { schemaVersion: 2 };`)).toHaveLength(1);
  });
});
