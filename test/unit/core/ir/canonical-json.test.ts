import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  toCanonicalArtifactText,
  toCanonicalDigestBytes,
} from '../../../../src/core/ir/canonical-json.js';
import { PlanDocument } from '../../../../src/core/ir/schema.js';
import type { JsonValueT } from '../../../../src/core/ir/schema.js';

const goldenFixtureDirectory = new URL('../../../fixtures/ir/golden/', import.meta.url);
const goldenArtifactText = readFileSync(new URL('plan.golden.artifact.json', goldenFixtureDirectory), 'utf8');
const goldenDigestBytes = readFileSync(new URL('plan.golden.digest-bytes', goldenFixtureDirectory));

function digestText(value: JsonValueT): string {
  return Buffer.from(toCanonicalDigestBytes(value)).toString('utf8');
}

function expectBothFormsToRejectWithValueSpecificErrors(value: unknown): void {
  const serializers = [
    () => toCanonicalDigestBytes(value as JsonValueT),
    () => toCanonicalArtifactText(value as JsonValueT),
  ];

  for (const serialize of serializers) {
    let thrown: unknown;

    try {
      serialize();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toBe('not implemented');
  }
}

function expectBothFormsToThrowRangeError(value: unknown): void {
  expect(() => toCanonicalDigestBytes(value as JsonValueT)).toThrow(RangeError);
  expect(() => toCanonicalArtifactText(value as JsonValueT)).toThrow(RangeError);
}

function asJsonValue(plan: PlanDocument): JsonValueT {
  return plan as unknown as JsonValueT;
}

describe('canonical JSON serialization', () => {
  it('serializes a simple object identically in compact and artifact forms', () => {
    const value: JsonValueT = { z: [true, null, 'x'], a: 1 };

    expect(digestText(value)).toBe('{"a":1,"z":[true,null,"x"]}');
    expect(toCanonicalArtifactText(value)).toBe('{\n  "a": 1,\n  "z": [\n    true,\n    null,\n    "x"\n  ]\n}\n');
    expect(JSON.parse(toCanonicalArtifactText(value))).toEqual(value);
  });

  it('uses the required JCS escaping for strings and member names', () => {
    const value: JsonValueT = {
      ['\u0001"\\']: '\u0000\b\t\n\f\r\u001F"\\/\u2028\u2029é',
    };
    const expected = '{"\\u0001\\"\\\\":"\\u0000\\b\\t\\n\\f\\r\\u001f\\"\\\\/  é"}';
    const expectedArtifact = '{\n  "\\u0001\\"\\\\": "\\u0000\\b\\t\\n\\f\\r\\u001f\\"\\\\/  é"\n}\n';

    expect(digestText(value)).toBe(expected);
    expect(toCanonicalArtifactText(value)).toBe(expectedArtifact);
  });

  it.each([NaN, Infinity, -Infinity])('rejects the non-finite number %s anywhere in the value tree', (value) => {
    expectBothFormsToThrowRangeError({ nested: [value] });
  });

  it('rejects an unpaired UTF-16 surrogate in a string value', () => {
    expectBothFormsToThrowRangeError({ value: '\uD800' });
  });

  it('rejects an unpaired UTF-16 surrogate in an object key', () => {
    expectBothFormsToThrowRangeError({ ['\uDC00']: 'value' });
  });

  it.each([
    ['undefined', undefined],
    ['bigint', BigInt(1)],
    ['function', () => undefined],
    ['symbol', Symbol('value')],
  ])('rejects a %s value anywhere in the value tree', (_description, value) => {
    expectBothFormsToRejectWithValueSpecificErrors({ nested: [value] });
  });

  it.each([
    [-0, '0'],
    [0.000001, '0.000001'],
    [0.0000009999999999999998, '9.999999999999997e-7'],
    [999999999999999900000, '999999999999999900000'],
    [1e21, '1e+21'],
  ])('uses the RFC 8785 number spelling %s', (value, expected) => {
    expect(digestText(value)).toBe(expected);
    expect(toCanonicalArtifactText(value)).toBe(`${expected}\n`);
  });

  it.each([
    [{}, '{}\n'],
    [[], '[]\n'],
  ] as Array<readonly [JsonValueT, string]>)('renders %j without introducing internal whitespace in digest bytes', (value, artifactText) => {
    expect(digestText(value)).toBe(artifactText.trimEnd());
    expect(toCanonicalArtifactText(value)).toBe(artifactText);
  });

  it('serializes deeply nested arrays and objects without changing their shape', () => {
    let value: JsonValueT = 'leaf';

    for (let level = 0; level < 128; level += 1) {
      value = { [`level-${level}`]: [value] };
    }

    const artifactText = toCanonicalArtifactText(value);

    expect(JSON.parse(digestText(value))).toEqual(value);
    expect(JSON.parse(artifactText)).toEqual(value);
  });

  it('uses RFC 8785 UTF-16 code-unit ordering for its full seven-key vector', () => {
    const value: JsonValueT = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      'דּ': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      'ö': 'Latin Small Letter O With Diaeresis',
    };

    expect(digestText(value)).toBe('{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}');
  });

  it('ignores source object key insertion order in both canonical forms', () => {
    const first: JsonValueT = {
      z: { second: 2, first: 1 },
      a: 'first',
    };
    const second: JsonValueT = {
      a: 'first',
      z: { first: 1, second: 2 },
    };

    expect(toCanonicalDigestBytes(first)).toEqual(toCanonicalDigestBytes(second));
    expect(toCanonicalArtifactText(first)).toBe(toCanonicalArtifactText(second));
  });

  // This raw fixture was hand-derived by sorting every member name as UTF-16
  // code units, applying JCS scalar spellings, and removing only structural
  // whitespace from the artifact form; its expected digest bytes have no final newline.
  it('matches the checked-in artifact text and compact-byte PlanDocument fixtures', () => {
    const plan = PlanDocument.parse(JSON.parse(goldenArtifactText));

    expect(toCanonicalArtifactText(asJsonValue(plan))).toBe(goldenArtifactText);
    expect(toCanonicalDigestBytes(asJsonValue(plan))).toEqual(goldenDigestBytes);
  });

  it('round-trips artifact JSON through parsing without changing canonical text', () => {
    const value: JsonValueT = { z: [true, { b: 2, a: 1 }], a: 'first' };
    const firstArtifactText = toCanonicalArtifactText(value);

    expect(toCanonicalArtifactText(JSON.parse(firstArtifactText) as JsonValueT)).toBe(firstArtifactText);
  });
});
