import { describe, expect, it } from 'vitest';
import { compileTestPattern, matchesTestPatterns } from '#core/discovery/pattern-match.js';

describe('compileTestPattern', () => {
  it.each([
    ['**/login.test.md', 'login.test.md'],
    ['**/login.test.md', 'ui/login.test.md'],
    ['**/login.test.md', 'ui/auth/mobile/login.test.md'],
    ['ui/**', 'ui/'],
    ['ui/**', 'ui/login.test.md'],
    ['ui/**', 'ui/auth/mobile/login.test.md'],
  ])('matches ** across zero, one, and many path segments: %s / %s', (pattern, path) => {
    expect(compileTestPattern(pattern).test(path)).toBe(true);
  });

  it('keeps * inside one segment while allowing zero or many non-slash characters', () => {
    const pattern = compileTestPattern('ui/*.test.md');

    expect(pattern.test('ui/.test.md')).toBe(true);
    expect(pattern.test('ui/login.test.md')).toBe(true);
    expect(pattern.test('ui/auth/login.test.md')).toBe(false);
  });

  it('treats every other regular-expression metacharacter as a literal', () => {
    const literal = '.+?()|[]{}^$\\';
    const pattern = compileTestPattern(`ui/${literal}.test.md`);

    expect(pattern.test(`ui/${literal}.test.md`)).toBe(true);
    expect(pattern.test('ui/anything.test.md')).toBe(false);
  });

  it('anchors matches to the complete relative path', () => {
    const pattern = compileTestPattern('login.test.md');

    expect(pattern.test('login.test.md')).toBe(true);
    expect(pattern.test('ui/login.test.md')).toBe(false);
    expect(pattern.test('login.test.md.bak')).toBe(false);
  });
});

describe('matchesTestPatterns', () => {
  it('selects paths that match testMatch but not testIgnore', () => {
    expect(matchesTestPatterns('ui/login.test.md', ['**/*.test.md'], ['**/.runs/**'])).toBe(true);
  });

  it('rejects paths that match neither configured collection', () => {
    expect(matchesTestPatterns('ui/login.md', ['**/*.test.md'], ['**/.runs/**'])).toBe(false);
  });

  it('gives testIgnore precedence when both collections match', () => {
    expect(matchesTestPatterns('ui/login.test.md', ['**/*.test.md'], ['**/*.test.md'])).toBe(false);
  });

  it('never selects a path when testMatch is empty, regardless of testIgnore', () => {
    expect(matchesTestPatterns('ui/login.test.md', [], [])).toBe(false);
    expect(matchesTestPatterns('ui/login.test.md', [], ['**/*.test.md'])).toBe(false);
  });
});
