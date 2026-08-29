import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  scanSchemaVersionLiteralViolations,
  type SchemaVersionLiteralViolation,
} from '../../../tools/schema-version-literal-scanner.js';

async function scan(
  source: string,
  schemaSource = 'export const PLAN_SCHEMA_VERSION = 2 as const;\nexport const GROUNDING_SCHEMA_VERSION = 1 as const;',
  extraFiles: Readonly<Record<string, string>> = {},
): Promise<readonly SchemaVersionLiteralViolation[]> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-schema-version-scanner-'));
  const schema = join(root, 'src/core/ir/schema.ts');
  const caller = join(root, 'src/usecases/synthetic.ts');
  try {
    await mkdir(join(root, 'src/core/ir'), { recursive: true });
    await mkdir(join(root, 'src/usecases'), { recursive: true });
    const extraFileNames = Object.keys(extraFiles).map((relativePath) => join(root, relativePath));
    await Promise.all([
      writeFile(schema, schemaSource),
      writeFile(caller, source),
      ...Object.entries(extraFiles).map(async ([relativePath, contents]) => {
        const fileName = join(root, relativePath);
        await mkdir(dirname(fileName), { recursive: true });
        await writeFile(fileName, contents);
      }),
    ]);
    const program = ts.createProgram({ rootNames: [schema, caller, ...extraFileNames], options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, strict: true, target: ts.ScriptTarget.ES2023 } });
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(program.getSemanticDiagnostics()).toEqual([]);
    return scanSchemaVersionLiteralViolations(program, schema);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe('scanSchemaVersionLiteralViolations()', () => {
  it.each([
    ['parenthesized literal', 'const value = { schemaVersion: (2) };'],
    ['as-const literal', 'const value = { schemaVersion: (2 as const) };'],
    ['type-asserted literal', 'const value = { schemaVersion: (2 as number) };'],
    ['signed numeric literal', 'const value = { schemaVersion: -2 };'],
    ['quoted string-literal property name', 'const value = { "schemaVersion": 2 };'],
    ['computed string-literal property name', 'const value = { ["schemaVersion"]: 2 };'],
    ['non-null-asserted literal', 'const value = { schemaVersion: 2! };'],
    ['shorthand numeric property', 'const schemaVersion = 2; const value = { schemaVersion };'],
    ['class property', 'class Value { schemaVersion = 2; }'],
    ['local numeric indirection', 'const LOCAL_SCHEMA_VERSION = 2; const value = { schemaVersion: LOCAL_SCHEMA_VERSION };'],
  ])('reports a %s', async (_name, source) => {
    expect(await scan(source)).toHaveLength(1);
  });

  it.each([
    [
      'a literal comparison',
      [
        'const plan = { schemaVersion: 2 };',
        'if (plan.schemaVersion !== 2) throw new Error();',
      ].join('\n'),
      { line: 2, column: 10 },
    ],
    [
      'an indirect numeric constant in a comparison at the comparison use site',
      [
        'const LOCAL_SCHEMA_VERSION = 2;',
        'const plan = { schemaVersion: 2 };',
        'if (plan.schemaVersion !== LOCAL_SCHEMA_VERSION) throw new Error();',
      ].join('\n'),
      { line: 3, column: 10 },
    ],
    [
      'a parenthesized schemaVersion comparison left-hand side',
      [
        'const plan = { schemaVersion: 2 };',
        'if ((plan.schemaVersion) !== 2) throw new Error();',
      ].join('\n'),
      { line: 2, column: 11 },
    ],
  ] as const)('reports %s at the schemaVersion use coordinate', async (_name, source, coordinate) => {
    const [violation] = await scan(source);
    expect(violation).toMatchObject(coordinate);
  });

  it('allows direct named imports of either canonical authority', async () => {
    expect(await scan([
      "import { PLAN_SCHEMA_VERSION, GROUNDING_SCHEMA_VERSION } from '../core/ir/schema.js';",
      'const plan = { schemaVersion: PLAN_SCHEMA_VERSION };',
      'const grounding = { schemaVersion: GROUNDING_SCHEMA_VERSION };',
      'if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) throw new Error();',
    ].join('\n'))).toEqual([]);
  });

  it('documents that namespace imports are outside the supported direct-binding contract', async () => {
    expect(await scan([
      "import * as Schema from '../core/ir/schema.js';",
      'const plan = { schemaVersion: Schema.PLAN_SCHEMA_VERSION };',
    ].join('\n'))).toHaveLength(1);
  });

  it('documents that barrel re-exports are outside the supported direct-binding contract', async () => {
    expect(await scan([
      "import { PLAN_SCHEMA_VERSION } from '../core/ir/schema-barrel.js';",
      'const plan = { schemaVersion: PLAN_SCHEMA_VERSION };',
    ].join('\n'), undefined, {
      'src/core/ir/schema-barrel.ts': "export { PLAN_SCHEMA_VERSION } from './schema.js';",
    })).toHaveLength(1);
  });

  it('allows only canonical constant declarations in schema.ts, not literal object fields there', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ambercast-schema-version-scanner-boundary-'));
    const schema = join(root, 'src/core/ir/schema.ts');
    try {
      await mkdir(join(root, 'src/core/ir'), { recursive: true });
      await writeFile(schema, [
        'export const PLAN_SCHEMA_VERSION = 2 as const;',
        'export const GROUNDING_SCHEMA_VERSION = 1 as const;',
        'export const invalid = { schemaVersion: 2 };',
      ].join('\n'));
      const program = ts.createProgram({ rootNames: [schema], options: { noEmit: true, strict: true, target: ts.ScriptTarget.ES2023 } });
      expect(scanSchemaVersionLiteralViolations(program, schema)).toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
