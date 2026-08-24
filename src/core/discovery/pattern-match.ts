/**
 * Provides the pure configured-path matcher shared by discovery and usecase
 * integrity checks.
 *
 * Keeping this predicate outside the filesystem adapter lets check judge an
 * inverse-derived virtual test path without another traversal or filesystem
 * access. It is deliberately a direct core import rather than a `CheckDeps`
 * callback: pure matching is not an injectable capability or adapter seam.
 */

/**
 * Compiles ambercast's intentionally small glob vocabulary into an anchored
 * regular expression.
 *
 * `**` spans zero or more complete path segments, including none, while `*`
 * spans zero or more characters within one segment. Other regular-expression
 * metacharacters are literal, and the bounded language deliberately excludes
 * character classes, braces, extglobs, and general glob behavior.
 */
export function compileTestPattern(pattern: string): RegExp {
  let expression = '^';

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
      continue;
    }
    if (character === '*') {
      expression += '[^/]*';
      continue;
    }

    expression += '\\^$+?.()|[]{}'.includes(character) ? `\\${character}` : character;
  }

  return new RegExp(`${expression}$`);
}

/**
 * Judges one POSIX-relative path against configured inclusion and exclusion
 * patterns.
 *
 * This predicate centralizes the matcher used by filesystem discovery so
 * usecases apply identical `testMatch` and `testIgnore` semantics after
 * deriving a path, without coupling their decision to I/O.
 * `testIgnore` takes precedence over `testMatch` when both match.
 */
export function matchesTestPatterns(
  relativePath: string,
  testMatch: readonly string[],
  testIgnore: readonly string[],
): boolean {
  return testMatch.some((pattern) => compileTestPattern(pattern).test(relativePath))
    && !testIgnore.some((pattern) => compileTestPattern(pattern).test(relativePath));
}
