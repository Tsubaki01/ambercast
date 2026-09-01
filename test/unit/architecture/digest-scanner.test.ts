import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { scanComputeInputsDigestAuthority, type DigestViolationKind } from '../../../tools/digest-scanner.js';

const digestSource = [
  'export interface DigestInputs { readonly schemaVersion: number; }',
  "export function computeInputsDigest(_inputs: DigestInputs): string { return 'digest'; }",
].join('\n');
type Scan = ReturnType<typeof scanComputeInputsDigestAuthority>;

async function withProgram(files: Readonly<Record<string, string>>, assertion: (program: ts.Program, names: Readonly<Record<string, string>>) => void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'ambercast-digest-scanner-'));
  const names = Object.fromEntries(Object.keys(files).map((path) => [path, join(root, path)]));
  try {
    await Promise.all(Object.entries(files).map(async ([path, text]) => {
      const fileName = names[path];
      if (fileName === undefined) throw new Error(`Missing synthetic name for ${path}.`);
      await mkdir(dirname(fileName), { recursive: true });
      await writeFile(fileName, text);
    }));
    const program = ts.createProgram({ rootNames: Object.values(names), options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, strict: true, target: ts.ScriptTarget.ES2023 } });
    expect(program.getSyntacticDiagnostics()).toEqual([]);
    expect(program.getSemanticDiagnostics()).toEqual([]);
    assertion(program, names);
  } finally { await rm(root, { force: true, recursive: true }); }
}

async function withCaller(source: string, assertion: (result: Scan, names: Readonly<Record<string, string>>) => void, caller = 'src/core/ai/plan-input-provenance.ts', extra: Readonly<Record<string, string>> = {}): Promise<void> {
  await withProgram({ 'src/core/ir/digest.ts': digestSource, [caller]: source, ...extra }, (program, names) => {
    const digest = names['src/core/ir/digest.ts'];
    const authority = names['src/core/ai/plan-input-provenance.ts'] ?? (digest === undefined ? undefined : join(dirname(digest), '../ai/plan-input-provenance.ts'));
    if (digest === undefined || authority === undefined) throw new Error('Synthetic digest files are missing.');
    assertion(scanComputeInputsDigestAuthority(program, digest, authority), names);
  });
}

function expectKinds(result: Scan, kinds: readonly DigestViolationKind[]): void { expect(result.violations.map(({ kind }) => kind)).toEqual(kinds); }

describe('scanComputeInputsDigestAuthority()', () => {
  test.each([
    ['an inline literal', 'computeInputsDigest({ schemaVersion: 1 });'],
    ['an as-expression literal', 'computeInputsDigest(({ schemaVersion: 1 }) as DigestInputs);'],
    ['an angle-bracket assertion literal', 'computeInputsDigest(<DigestInputs>{ schemaVersion: 1 });'],
    ['a satisfies-expression literal', 'computeInputsDigest(({ schemaVersion: 1 }) satisfies DigestInputs);'],
    ['a parenthesized literal', 'computeInputsDigest((({ schemaVersion: 1 })));'],
  ])('records %s as a clean authority call', async (_name, call) => {
    await withCaller(["import { computeInputsDigest, type DigestInputs } from '../ir/digest.js';", call].join('\n'), (result, names) => {
      expect(result).toEqual({ calls: [expect.objectContaining({ fileName: names['src/core/ai/plan-input-provenance.ts'] })], violations: [] });
    });
  });

  test.each([
    ['a bare identifier', 'const input = { schemaVersion: 1 }; computeInputsDigest(input);', 'argument-must-be-inline-object-literal'],
    ['a member access', 'const source = { input: { schemaVersion: 1 } }; computeInputsDigest(source.input);', 'argument-must-be-inline-object-literal'],
    ['a spread', 'const input = { schemaVersion: 1 }; computeInputsDigest({ ...input });', 'argument-must-not-contain-spread'],
    ['a wrapped spread', 'const input = { schemaVersion: 1 }; computeInputsDigest(({ ...input }) as DigestInputs);', 'argument-must-not-contain-spread'],
  ] as const)('rejects a call with %s', async (_name, body, kind) => {
    await withCaller(["import { computeInputsDigest, type DigestInputs } from '../ir/digest.js';", body].join('\n'), (result) => { expect(result.calls).toHaveLength(1); expectKinds(result, [kind]); });
  });

  test.each([
    ['local re-bind', 'const local = computeInputsDigest; void local;', 2],
    ['.bind()', 'computeInputsDigest.bind(null);', 2],
    ['.call()', 'computeInputsDigest.call(null, { schemaVersion: 1 });', 2],
    ['.apply()', 'computeInputsDigest.apply(null, [{ schemaVersion: 1 }]);', 2],
    ['passing as an argument', 'declare function accept(value: unknown): void; accept(computeInputsDigest);', 2],
    ['returning it', 'function value(): unknown { return computeInputsDigest; } void value;', 2],
    ['storing it in an object literal', 'const value = { computeInputsDigest }; void value;', 2],
    ['storing it in an array literal', 'const value = [computeInputsDigest]; void value;', 2],
    ['namespace destructuring shorthand', "import * as digest from '../ir/digest.js'; const { computeInputsDigest } = digest;", 1],
    ['namespace destructuring rename', "import * as digest from '../ir/digest.js'; const { computeInputsDigest: local } = digest; void local;", 1],
    ['namespace-typed parameter destructuring', "import * as digest from '../ir/digest.js'; function consume({ computeInputsDigest }: typeof digest): void { void computeInputsDigest; }", 1],
    ['namespace assignment destructuring shorthand', "import * as digest from '../ir/digest.js'; let computeInputsDigest: unknown; ({ computeInputsDigest } = digest);", 1],
    ['namespace assignment destructuring rename', "import * as digest from '../ir/digest.js'; let local: unknown; ({ computeInputsDigest: local } = digest);", 1],
    ['non-callee namespace member access', "import * as digest from '../ir/digest.js'; const local = digest.computeInputsDigest; void local;", 1],
    ['bracket member access', "import * as digest from '../ir/digest.js'; const local = digest['computeInputsDigest']; void local;", 1],
    ['value re-export', "export { computeInputsDigest } from '../ir/digest.js';", 1],
    ['renamed value re-export', "export { computeInputsDigest as digest } from '../ir/digest.js';", 1],
    ['star value re-export', "export * from '../ir/digest.js';", 1],
    ['namespace star value re-export', "export * as digest from '../ir/digest.js';", 1],
  ])('rejects %s as a canonical value reference', async (_name, body, expectedLine) => {
    const source = body.includes('import ') || body.startsWith('export ')
      ? body
      : ["import { computeInputsDigest } from '../ir/digest.js';", body].join('\n');
    await withCaller(source, (result, names) => {
      expect(result.calls).toEqual([]); expectKinds(result, ['value-reference-outside-authority-call']);
      expect(result.violations[0]).toMatchObject({ fileName: names['src/core/ai/plan-input-provenance.ts'], line: expectedLine, column: expect.any(Number) });
    });
  });

  test('flags a call through a two-level barrel chain outside the authority', async () => {
    await withCaller("import { computeInputsDigest } from '../core/ir/barrel-two.js';\ncomputeInputsDigest({ schemaVersion: 1 });", (result, names) => {
      expect(result).toEqual({
        calls: [{ fileName: names['src/usecases/outside.ts'], line: 2, column: 1 }],
        violations: [
          { fileName: names['src/core/ir/barrel-one.ts'], line: 1, column: 10, kind: 'value-reference-outside-authority-call' },
          { fileName: names['src/core/ir/barrel-two.ts'], line: 1, column: 10, kind: 'value-reference-outside-authority-call' },
          { fileName: names['src/usecases/outside.ts'], line: 2, column: 1, kind: 'call-site-outside-authority' },
        ],
      });
    }, 'src/usecases/outside.ts', {
      'src/core/ir/barrel-one.ts': "export { computeInputsDigest } from './digest.js';",
      'src/core/ir/barrel-two.ts': "export { computeInputsDigest } from './barrel-one.js';",
    });
  });

  test('treats relative and absolute spellings of the authority path identically', async () => {
    await withProgram({
      'src/core/ir/digest.ts': digestSource,
      'src/core/ai/plan-input-provenance.ts': "import { computeInputsDigest } from '../ir/digest.js';\ncomputeInputsDigest({ schemaVersion: 1 });",
    }, (program, names) => {
      const digest = names['src/core/ir/digest.ts'];
      const authority = names['src/core/ai/plan-input-provenance.ts'];
      if (digest === undefined || authority === undefined) throw new Error('Synthetic digest files are missing.');
      const relativeAuthority = relative(process.cwd(), authority);

      expect(scanComputeInputsDigestAuthority(program, digest, relativeAuthority).violations).toEqual([]);
      expect(scanComputeInputsDigestAuthority(program, digest, authority).violations).toEqual([]);
    });
  });

  test.each([
    ['an import-type binding', "import type { computeInputsDigest } from '../ir/digest.js';"],
    ['a per-specifier type import', "import { type computeInputsDigest } from '../ir/digest.js';"],
    ['a type re-export', "export type { computeInputsDigest } from '../ir/digest.js';"],
    ['a type-only star re-export', "export type * from '../ir/digest.js';"],
    ['a typeof type query', "import { computeInputsDigest } from '../ir/digest.js'; type Digest = typeof computeInputsDigest; void (0 as unknown as Digest);"],
    ['an unused external value import', "import { computeInputsDigest } from '../ir/digest.js';"],
    ['an unrelated same-named local function', 'function computeInputsDigest(value: object): object { return value; } computeInputsDigest({ schemaVersion: 1 });'],
  ])('allows %s', async (_name, body) => { await withCaller(body, (result) => expect(result).toEqual({ calls: [], violations: [] })); });

  test.each([
    ['a renamed import', "import { computeInputsDigest as digest } from '../ir/digest.js';", 'digest({ schemaVersion: 1 });'],
    ['a namespace-qualified call', "import * as digest from '../ir/digest.js';", 'digest.computeInputsDigest({ schemaVersion: 1 });'],
    ['an element-access call', "import * as digest from '../ir/digest.js';", "digest['computeInputsDigest']({ schemaVersion: 1 });"],
  ])('allows %s at the authority without reporting callee descendants', async (_name, importStatement, call) => {
    await withCaller([importStatement, call].join(' '), (result, names) => {
      expect(result).toEqual({
        calls: [{ fileName: names['src/core/ai/plan-input-provenance.ts'], line: 1, column: importStatement.length + 2 }],
        violations: [],
      });
    });
  });

  test('reports a call outside authority and its malformed argument as separate flat findings', async () => {
    await withCaller("import { computeInputsDigest } from '../core/ir/digest.js'; const input = { schemaVersion: 1 }; computeInputsDigest(input);", (result) => { expect(result.calls).toHaveLength(1); expectKinds(result, ['argument-must-be-inline-object-literal', 'call-site-outside-authority']); }, 'src/usecases/outside.ts');
  });

  test('reports an aliased call outside authority and its malformed argument as separate flat findings', async () => {
    await withCaller("import { computeInputsDigest as digest } from '../core/ir/digest.js'; const input = { schemaVersion: 1 }; digest(input);", (result) => { expect(result.calls).toHaveLength(1); expectKinds(result, ['argument-must-be-inline-object-literal', 'call-site-outside-authority']); }, 'src/usecases/outside.ts');
  });

  test.each([
    ['a renamed import', "import { computeInputsDigest as digest } from '../core/ir/digest.js';\ndigest({ schemaVersion: 1 });"],
    ['a namespace-qualified expression', "import * as digest from '../core/ir/digest.js';\ndigest.computeInputsDigest({ schemaVersion: 1 });"],
  ])('reports call-site-outside-authority for %s outside the authority', async (_name, source) => {
    await withCaller(source, (result) => {
      expect(result.calls).toHaveLength(1);
      expectKinds(result, ['call-site-outside-authority']);
    }, 'src/usecases/outside.ts');
  });

  test('reports namespace-qualified calls outside authority with malformed arguments', async () => {
    await withCaller("import * as digest from '../core/ir/digest.js';\nconst input = { schemaVersion: 1 };\ndigest.computeInputsDigest(input);", (result) => {
      expect(result.calls).toHaveLength(1);
      expectKinds(result, ['argument-must-be-inline-object-literal', 'call-site-outside-authority']);
    }, 'src/usecases/outside.ts');
  });

  test('does not treat a same-basename file as the authority', async () => {
    await withProgram({
      'src/core/ir/digest.ts': digestSource,
      'src/core/ai/plan-input-provenance.ts': 'export {};',
      'other-dir/plan-input-provenance.ts': "import { computeInputsDigest } from '../src/core/ir/digest.js'; computeInputsDigest({ schemaVersion: 1 });",
    }, (program, names) => {
      const result = scanComputeInputsDigestAuthority(program, names['src/core/ir/digest.ts'] ?? '', names['src/core/ai/plan-input-provenance.ts'] ?? '');
      expect(result.calls).toHaveLength(1);
      expectKinds(result, ['call-site-outside-authority']);
    });
  });

  test('rejects a spread nested within an inline object-literal argument', async () => {
    await withCaller("import { computeInputsDigest, type DigestInputs } from '../ir/digest.js';\nconst input = { schemaVersion: 1 };\ncomputeInputsDigest(({ nested: { ...input } }) as unknown as DigestInputs);", (result) => {
      expect(result.calls).toHaveLength(1);
      expectKinds(result, ['argument-must-not-contain-spread']);
    });
  });

  test('rejects an array spread nested within an inline object-literal argument', async () => {
    await withCaller("import { computeInputsDigest, type DigestInputs } from '../ir/digest.js';\nconst values = [1];\ncomputeInputsDigest({ schemaVersion: 1, items: [...values] } as DigestInputs);", (result) => {
      expect(result.calls).toHaveLength(1);
      expectKinds(result, ['argument-must-not-contain-spread']);
    });
  });

  test('rejects a nested destructuring rebind of the canonical digest function', async () => {
    await withCaller("import * as digest from '../ir/digest.js';\nconst source: { outer: typeof digest } = { outer: digest };\nconst { outer: { computeInputsDigest } } = source;", (result) => {
      expect(result.calls).toEqual([]);
      expectKinds(result, ['value-reference-outside-authority-call']);
    });
  });

  test.each([
    ['a call', "import * as digest from '../ir/digest.js';\nconst key = 'computeInputsDigest' as const;\ndigest[key]({ schemaVersion: 1 });", true],
    ['a value reference', "import * as digest from '../ir/digest.js';\nconst key = 'computeInputsDigest' as const;\nconst local = digest[key];\nvoid local;", false],
  ])('rejects a const-bound literal computed key %s', async (_name, source, isCall) => {
    await withCaller(source, (result) => {
      expect(result.calls).toHaveLength(isCall ? 1 : 0);
      expectKinds(result, isCall ? [] : ['value-reference-outside-authority-call']);
    });
  });

  test.each([
    ['a call', "import * as digest from '../ir/digest.js';\ndeclare const key: string;\nconst namespace = digest as typeof digest & Record<string, (input: { schemaVersion: number }) => string>;\nnamespace[key]({ schemaVersion: 1 });"],
    ['a value reference', "import * as digest from '../ir/digest.js';\ndeclare const key: string;\nconst namespace = digest as typeof digest & Record<string, (input: { schemaVersion: number }) => string>;\nconst local = namespace[key];\nvoid local;"],
  ])('rejects a dynamic digest namespace computed key %s', async (_name, source) => {
    await withCaller(source, (result) => {
      expect(result.calls).toEqual([]);
      expectKinds(result, ['value-reference-outside-authority-call']);
    });
  });

  test('allows a dynamic computed key on an unrelated indexed object', async () => {
    await withCaller('declare const key: string; declare const unrelated: Record<string, (input: { schemaVersion: number }) => string>; unrelated[key]({ schemaVersion: 1 });', (result) => {
      expect(result).toEqual({ calls: [], violations: [] });
    });
  });

  test.each([
    ['a direct quoted binding', "import * as digest from '../ir/digest.js';\nconst { 'computeInputsDigest': local } = digest;\nvoid local;"],
    ['a one-level-nested quoted binding', "import * as digest from '../ir/digest.js';\nconst source: { outer: typeof digest } = { outer: digest };\nconst { 'outer': { 'computeInputsDigest': local } } = source;\nvoid local;"],
  ])('rejects %s', async (_name, source) => {
    await withCaller(source, (result) => {
      expect(result.calls).toEqual([]);
      expectKinds(result, ['value-reference-outside-authority-call']);
    });
  });

  test.each([
    ['a resolvable computed binding', "import * as digest from '../ir/digest.js';\nconst key = 'computeInputsDigest' as const;\nconst { [key]: local } = digest;\nvoid local;"],
    ['a dynamic computed binding', "import * as digest from '../ir/digest.js';\ndeclare const key: string;\nconst namespace: typeof digest & Record<string, unknown> = digest;\nconst { [key]: local } = namespace;\nvoid local;"],
  ])('rejects %s', async (_name, source) => {
    await withCaller(source, (result) => {
      expect(result.calls).toEqual([]);
      expectKinds(result, ['value-reference-outside-authority-call']);
    });
  });

  test.each([
    ['a finite union that includes the canonical key', "import * as digest from '../ir/digest.js';\ndeclare const key: 'computeInputsDigest' | 'other';\ndigest[key]({ schemaVersion: 1 });", ['value-reference-outside-authority-call']],
    ['a finite union that excludes the canonical key', "import * as digest from '../ir/digest.js';\ndeclare const key: 'other';\ndigest[key]({ schemaVersion: 1 });", []],
  ] as const)('distinguishes %s', async (_name, source, expectedKinds) => {
    await withCaller(source, (result) => {
      expect(result.calls).toEqual([]);
      expectKinds(result, expectedKinds);
    }, undefined, { 'src/core/ir/digest.ts': `${digestSource}\nexport function other(_input: DigestInputs): string { return 'other'; }` });
  });

  test.each([
    ['a parenthesized direct import callee', "import { computeInputsDigest } from '../ir/digest.js';\n(computeInputsDigest)({ schemaVersion: 1 });"],
    ['a non-null asserted namespace member callee', "import * as digest from '../ir/digest.js';\ndigest.computeInputsDigest!({ schemaVersion: 1 });"],
  ])('classifies %s as an authority call', async (_name, source) => {
    await withCaller(source, (result) => {
      expect(result.calls).toHaveLength(1);
      expect(result.violations).toEqual([]);
    });
  });

  test('records a potential computed-key call exactly once', async () => {
    await withCaller("import * as digest from '../ir/digest.js';\ndeclare const key: 'computeInputsDigest' | 'other';\ndigest[key]({ schemaVersion: 1 });", (result) => {
      expect(result.calls).toEqual([]);
      expect(result.violations).toHaveLength(1);
      expectKinds(result, ['value-reference-outside-authority-call']);
    }, undefined, { 'src/core/ir/digest.ts': `${digestSource}\nexport function other(_input: DigestInputs): string { return 'other'; }` });
  });

  test('rejects an any-typed alias of the digest namespace', async () => {
    await withCaller("import * as digest from '../ir/digest.js';\nconst alias: any = digest;\nalias.computeInputsDigest({ schemaVersion: 1 });", (result) => {
      expect(result.calls).toEqual([]);
      expectKinds(result, ['value-reference-outside-authority-call']);
    });
  });

  test('rejects a non-call any-typed alias property reference', async () => {
    await withCaller("import * as digest from '../ir/digest.js';\nconst alias: any = digest;\nconst fn = alias.computeInputsDigest;\nvoid fn;", (result, names) => {
      expect(result.calls).toEqual([]);
      expect(result.violations).toEqual([
        {
          fileName: names['src/core/ai/plan-input-provenance.ts'],
          line: 3,
          column: 18,
          kind: 'value-reference-outside-authority-call',
        },
      ]);
    });
  });

  test('throws when the digest module is absent or lacks the canonical export', async () => {
    await withProgram({ 'src/core/ai/plan-input-provenance.ts': 'export {};' }, (program, names) => { expect(() => scanComputeInputsDigestAuthority(program, join(dirname(names['src/core/ai/plan-input-provenance.ts'] ?? ''), '../ir/digest.ts'), names['src/core/ai/plan-input-provenance.ts'] ?? '')).toThrow(/digest|computeInputsDigest/i); });
    await withProgram({ 'src/core/ir/digest.ts': 'export const other = 1;', 'src/core/ai/plan-input-provenance.ts': 'export {};' }, (program, names) => { expect(() => scanComputeInputsDigestAuthority(program, names['src/core/ir/digest.ts'] ?? '', names['src/core/ai/plan-input-provenance.ts'] ?? '')).toThrow(/computeInputsDigest/i); });
  });

  test('is cycle safe for unrelated circular barrels', async () => {
    await withCaller('export {};', (result) => expect(result).toEqual({ calls: [], violations: [] }), undefined, { 'src/core/ir/a.ts': "export * from './b.js';", 'src/core/ir/b.ts': "export * from './a.js';" });
  });

  test('sorts calls and findings by canonical full path, coordinate, and kind', async () => {
    const authoritySource = "import { computeInputsDigest } from '../ir/digest.js'; computeInputsDigest({ schemaVersion: 1 });";
    const firstCallerSource = "import { computeInputsDigest } from './core/ir/digest.js'; const input = { schemaVersion: 1 }; computeInputsDigest(input); const local = computeInputsDigest;";
    const secondCallerSource = "import { computeInputsDigest } from '../src/core/ir/digest.js'; const local = computeInputsDigest;";
    await withProgram({
      'src/core/ir/digest.ts': digestSource,
      'src/core/ai/plan-input-provenance.ts': authoritySource,
      'src/a.ts': firstCallerSource,
      'other/a.ts': secondCallerSource,
    }, (program, names) => {
      const result = scanComputeInputsDigestAuthority(program, names['src/core/ir/digest.ts'] ?? '', names['src/core/ai/plan-input-provenance.ts'] ?? '');
      expect(result.calls).toEqual([
        { fileName: names['src/a.ts'], line: 1, column: firstCallerSource.lastIndexOf('computeInputsDigest(') + 1 },
        { fileName: names['src/core/ai/plan-input-provenance.ts'], line: 1, column: authoritySource.lastIndexOf('computeInputsDigest(') + 1 },
      ]);
      expect(result.violations).toEqual([
        { fileName: names['other/a.ts'], line: 1, column: secondCallerSource.lastIndexOf('computeInputsDigest') + 1, kind: 'value-reference-outside-authority-call' },
        { fileName: names['src/a.ts'], line: 1, column: firstCallerSource.lastIndexOf('computeInputsDigest(') + 1, kind: 'argument-must-be-inline-object-literal' },
        { fileName: names['src/a.ts'], line: 1, column: firstCallerSource.lastIndexOf('computeInputsDigest(') + 1, kind: 'call-site-outside-authority' },
        { fileName: names['src/a.ts'], line: 1, column: firstCallerSource.lastIndexOf('computeInputsDigest') + 1, kind: 'value-reference-outside-authority-call' },
      ]);
    });
  });
});
