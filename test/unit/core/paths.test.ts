import { describe, expect, it } from 'vitest';
import { basenamePath, dirnamePath, isAbsolutePath, joinPath, relativeWithin } from '#core/paths.js';

describe('joinPath', () => {
  it.each([
    ['/', 'case', '/case'],
    ['/', '', '/'],
    ['suite', 'nested/case', 'suite/nested/case'],
    ['', 'case', 'case'],
    ['/suite', '', '/suite'],
    ['/suite', 'nested/case', '/suite/nested/case'],
    ['', '', ''],
  ])('joins normalized %j and %j as %j', (base, segment, expected) => {
    expect(joinPath(base, segment)).toBe(expected);
  });

  it.each([
    ['base trailing separator', 'suite/', 'case'],
    ['base repeated separator', 'suite//nested', 'case'],
    ['base repeated leading separator', '//suite', 'case'],
    ['base absolute trailing separator', '/suite/', 'case'],
    ['base absolute repeated separator', '/suite//nested', 'case'],
    ['base exact dot segment', '.', 'case'],
    ['base exact parent segment', '..', 'case'],
    ['base leading dot segment', './suite', 'case'],
    ['base leading parent segment', '../suite', 'case'],
    ['base interior dot segment', 'suite/./nested', 'case'],
    ['base interior parent segment', 'suite/../nested', 'case'],
    ['base terminal dot segment', 'suite/.', 'case'],
    ['base terminal parent segment', 'suite/..', 'case'],
    ['absolute child', 'suite', '/case'],
    ['child trailing separator', 'suite', 'nested/'],
    ['child repeated separator', 'suite', 'nested//case'],
    ['child repeated leading separator', 'suite', '//case'],
    ['child exact dot segment', 'suite', '.'],
    ['child exact parent segment', 'suite', '..'],
    ['child leading dot segment', 'suite', './case'],
    ['child leading parent segment', 'suite', '../case'],
    ['child interior dot segment', 'suite', 'nested/./case'],
    ['child interior parent segment', 'suite', 'nested/../case'],
    ['child terminal dot segment', 'suite', 'nested/.'],
    ['child terminal parent segment', 'suite', 'nested/..'],
  ])('rejects a %s', (_name, base, segment) => {
    expect(() => joinPath(base, segment)).toThrow(RangeError);
  });
});

describe('dirnamePath', () => {
  it.each([
    ['', ''],
    ['/', '/'],
    ['case', ''],
    ['suite/case', 'suite'],
    ['/case', '/'],
    ['/suite/case', '/suite'],
    ['/suite/nested/case', '/suite/nested'],
  ])('returns the parent of %j as %j', (path, expected) => {
    expect(dirnamePath(path)).toBe(expected);
  });

  it.each([
    'case/',
    '/case/',
    'suite//case',
    '/suite//case',
    '//suite',
    '.',
    '..',
    './case',
    '../case',
    'suite/./case',
    'suite/../case',
    'suite/.',
    'suite/..',
  ])('rejects malformed path %j', (path) => {
    expect(() => dirnamePath(path)).toThrow(RangeError);
  });
});

describe('basenamePath', () => {
  it.each([
    ['', ''],
    ['/', ''],
    ['case', 'case'],
    ['suite/case', 'case'],
    ['/suite/case', 'case'],
    ['/suite/nested/case.test.md', 'case.test.md'],
  ])('returns the terminal segment of %j as %j', (path, expected) => {
    expect(basenamePath(path)).toBe(expected);
  });

  it.each([
    'case/',
    '/case/',
    'suite//case',
    '/suite//case',
    '//suite',
    '.',
    '..',
    './case',
    '../case',
    'suite/./case',
    'suite/../case',
    'suite/.',
    'suite/..',
  ])('rejects malformed path %j', (path) => {
    expect(() => basenamePath(path)).toThrow(RangeError);
  });
});

describe('isAbsolutePath', () => {
  it.each([
    ['/', true],
    ['/suite/case', true],
    ['', false],
    ['case', false],
    ['suite/case', false],
  ])('classifies %j as absolute: %s', (path, expected) => {
    expect(isAbsolutePath(path)).toBe(expected);
  });

  it.each([
    '/suite/',
    '/suite//case',
    '//suite',
    '.',
    '..',
    './case',
    '../case',
    'suite/./case',
    'suite/../case',
    'suite/.',
    'suite/..',
  ])('rejects malformed path %j', (path) => {
    expect(() => isAbsolutePath(path)).toThrow(RangeError);
  });
});

describe('relativeWithin', () => {
  it.each([
    ['', '', ''],
    ['/tests', '/tests', ''],
    ['/tests', '/tests/ui/case.test.md', 'ui/case.test.md'],
    ['suite', 'suite', ''],
    ['suite', 'suite/case', 'case'],
    ['', 'suite/case', 'suite/case'],
    ['/', '/', ''],
    ['/', '/suite/case', 'suite/case'],
  ])('returns %j for target %j within root %j', (root, target, expected) => {
    expect(relativeWithin(root, target)).toBe(expected);
  });

  it.each([
    ['/tests', '/tests-archive/case'],
    ['/tests/ambercast', '/tests/ambercast-evil/case.test.md'],
    ['/tests', 'tests/case'],
    ['suite', '/suite/case'],
    ['suite', 'suites/case'],
    ['suite/case', 'suite'],
    ['/suite/case', '/suite'],
    ['/tests', '/other/case'],
  ])('does not match target %j outside root %j', (root, target) => {
    expect(relativeWithin(root, target)).toBeUndefined();
  });

  it.each([
    ['.', 'case'],
    ['..', 'case'],
    ['./suite', 'suite/case'],
    ['../suite', 'suite/case'],
    ['suite/./nested', 'suite/case'],
    ['suite/..', 'suite/case'],
    ['suite/.', 'suite/case'],
    ['suite', './case'],
    ['suite', '../case'],
    ['suite', 'suite/./case'],
    ['suite', 'suite/../case'],
    ['suite', 'suite/.'],
    ['suite', 'suite/..'],
    ['suite/', 'suite/case'],
    ['suite', 'suite//case'],
    ['//suite', '/suite/case'],
    ['/suite/', '/suite/case'],
    ['/suite//nested', '/suite/case'],
    ['/.', '/suite/case'],
    ['/..', '/suite/case'],
    ['/./suite', '/suite/case'],
    ['/../suite', '/suite/case'],
    ['/suite/./nested', '/suite/case'],
    ['/suite/../nested', '/suite/case'],
    ['/suite/.', '/suite/case'],
    ['/suite/..', '/suite/case'],
    ['/suite', '//suite/case'],
    ['/suite', '/suite/'],
    ['/suite', '/suite//case'],
    ['/suite', '/.'],
    ['/suite', '/..'],
    ['/suite', '/./case'],
    ['/suite', '/../case'],
    ['/suite', '/nested/./case'],
    ['/suite', '/nested/../case'],
    ['/suite', '/nested/.'],
    ['/suite', '/nested/..'],
  ])('treats malformed root or target paths as non-matching (%j, %j)', (root, target) => {
    expect(relativeWithin(root, target)).toBeUndefined();
  });
});
