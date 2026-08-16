/*
 * Defines the small POSIX path vocabulary shared by core configuration and
 * layout code. Core cannot import `node:path`, including its POSIX subpath,
 * so this boundary keeps its permitted dependencies intentionally narrow.
 *
 * The functions reject `.` and `..` path segments instead of trying
 * to normalize them. That matches StorageAdapter's opaque-path contract and
 * avoids two subsystems silently applying competing normalization rules.
 */

/**
 * Joins a normalized base path with a normalized relative child path using a
 * forward slash.
 *
 * A normalized POSIX path is `''`, `/`, or one or more non-empty segments
 * separated by single forward slashes, with `/` only as the leading marker of
 * an absolute path. `base` may be absolute or relative. `segment` is a
 * relative path, so it may contain more than one segment but cannot begin
 * with `/`.
 *
 * @param base - The normalized POSIX-style path to extend.
 * @param segment - The normalized relative path or segment to append.
 * @returns The combined POSIX-style path.
 * @throws {RangeError} When an input has a leading, trailing, or repeated
 *   separator outside the `/` root form; contains a `.` or `..` segment; or
 *   when `segment` is absolute.
 * @example
 * ```ts
 * joinPath('/', 'case') // '/case'
 * joinPath('suite', 'nested/case') // 'suite/nested/case'
 * joinPath('', 'case') // 'case'
 * joinPath('/suite', '') // '/suite'
 * ```
 * @remarks
 * This module stays narrower than general filesystem path handling so core
 * callers retain a portable, deterministic convention.
 */
export function joinPath(base: string, segment: string): string {
  assertNormalizedPath(base);
  assertNormalizedPath(segment);

  if (segment.startsWith('/')) {
    throw new RangeError('A joined path segment must be relative.');
  }

  if (base === '' || segment === '') {
    return base === '' ? segment : base;
  }

  return base === '/' ? `/${segment}` : `${base}/${segment}`;
}

/**
 * Finds the parent of a normalized POSIX-style path.
 *
 * The accepted forms are `''`, `/`, a relative segment sequence, or an
 * absolute segment sequence, all with single forward-slash separators. The
 * empty relative path stays empty, and `/` stays `/`; those are the two
 * parentless forms. A single relative segment has `''` as its parent, while a
 * single absolute segment has `/` as its parent.
 *
 * @param path - The normalized POSIX-style path whose parent is needed.
 * @returns The enclosing path, `''` for an empty or single-segment relative
 *   path, or `/` for the root and a single-segment absolute path.
 * @throws {RangeError} When the input has an invalid separator layout or a
 *   `.` or `..` segment.
 * @example
 * ```ts
 * dirnamePath('case') // ''
 * dirnamePath('suite/case') // 'suite'
 * dirnamePath('/case') // '/'
 * dirnamePath('/') // '/'
 * ```
 * @remarks
 * Returning the root unchanged gives an ancestor walk a stable termination
 * condition without consulting a filesystem.
 */
export function dirnamePath(path: string): string {
  assertNormalizedPath(path);

  if (path === '' || path === '/') {
    return path;
  }

  const separatorIndex = path.lastIndexOf('/');
  if (separatorIndex === -1) {
    return '';
  }

  return separatorIndex === 0 ? '/' : path.slice(0, separatorIndex);
}

/**
 * Extracts the final segment of a normalized POSIX-style path.
 *
 * The accepted forms are `''`, `/`, a relative segment sequence, or an
 * absolute segment sequence, all with single forward-slash separators. Both
 * the empty relative path and `/` have no terminal segment and return `''`.
 *
 * @param path - The normalized POSIX-style path whose final segment is needed.
 * @returns The terminal path segment, or `''` for `''` and `/`.
 * @throws {RangeError} When the input has an invalid separator layout or a
 *   `.` or `..` segment.
 * @example
 * ```ts
 * basenamePath('case') // 'case'
 * basenamePath('suite/case') // 'case'
 * basenamePath('/suite/case') // 'case'
 * basenamePath('/') // ''
 * ```
 */
export function basenamePath(path: string): string {
  assertNormalizedPath(path);

  return path === '' || path === '/' ? '' : path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Determines whether a normalized POSIX-style path is rooted at `/`.
 *
 * The accepted forms are `''`, `/`, a relative segment sequence, or an
 * absolute segment sequence, all with single forward-slash separators. The
 * empty relative path and every single-segment relative path are not
 * absolute.
 *
 * @param path - The normalized POSIX-style path to classify.
 * @returns `true` when the path is absolute and `false` otherwise.
 * @throws {RangeError} When the input has an invalid separator layout or a
 *   `.` or `..` segment.
 * @example
 * ```ts
 * isAbsolutePath('/') // true
 * isAbsolutePath('/suite/case') // true
 * isAbsolutePath('case') // false
 * isAbsolutePath('') // false
 * ```
 * @remarks
 * This is deliberately a POSIX predicate; drive letters, UNC roots, and
 * backslash separators are not part of core's path contract.
 */
export function isAbsolutePath(path: string): boolean {
  assertNormalizedPath(path);

  return path.startsWith('/');
}

/**
 * Produces a path relative to a root only when the target is that root or a
 * true descendant of it.
 *
 * `root` and `target` each accept `''`, `/`, a relative segment sequence, or
 * an absolute segment sequence, with single forward-slash separators. They
 * must have the same absolute/relative kind: an absolute target is never
 * within a relative root, and a relative target is never within an absolute
 * root. The empty relative root contains every normalized relative target.
 *
 * @param root - The normalized POSIX-style containment boundary.
 * @param target - The normalized POSIX-style path to test against the boundary.
 * @returns The relative suffix, including an empty suffix for the root itself,
 *   or `undefined` when the target is outside the boundary, the inputs have
 *   different absolute/relative kinds, or either input is malformed.
 * @example
 * ```ts
 * relativeWithin('/tests', '/tests') // ''
 * relativeWithin('/tests', '/tests/ui/case.test.md') // 'ui/case.test.md'
 * relativeWithin('suite', 'suite/case') // 'case'
 * relativeWithin('/tests', 'tests/case') // undefined
 * relativeWithin('/tests', '/tests-archive/case') // undefined
 * ```
 * @remarks
 * The descendant check uses a raw-prefix match anchored on a full trailing
 * `/` separator, which makes the string comparison segment-boundary-safe.
 * That prevents a sibling such as `tests/ambercast-evil` from being mistaken
 * for a descendant of `tests/ambercast`.
 */
export function relativeWithin(root: string, target: string): string | undefined {
  if (!isNormalizedPath(root) || !isNormalizedPath(target) || root.startsWith('/') !== target.startsWith('/')) {
    return undefined;
  }

  if (root === target) {
    return '';
  }

  if (root === '') {
    return target;
  }

  if (root === '/') {
    return target.slice(1);
  }

  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : undefined;
}

/**
 * Produces a usable relative report identity when possible; otherwise
 * preserves the original target.
 *
 * This remains a sibling of {@link relativeWithin} because the two callers
 * need different failure policies. General containment checks signal that no
 * relative path exists with `undefined`, while required identity fields must
 * retain an original path rather than lose their value.
 *
 * @param root - The POSIX-style containment boundary. It need not be
 *   normalized: malformed inputs and absolute/relative kind mismatches leave
 *   `target` unchanged.
 * @param target - The path to make reportable. It need not be normalized or
 *   non-blank; an already-blank value is preserved unchanged.
 * @returns A usable relative suffix or the unchanged `target`. A target
 *   containing a non-whitespace character always produces a result containing
 *   one; this function preserves validity rather than sanitizing an
 *   already-invalid target.
 * @remarks
 * Report consumers require non-empty identity strings. When a non-blank target
 * is equal to the root or has a blank contained suffix, preserving the
 * original target prevents an invalid relative identity. Local validation
 * keeps this low-level path module independent of the higher report-schema
 * layer while aligning its relative output with that layer's acceptance rule.
 */
export function relativeWithinOrOriginal(root: string, target: string): string {
  const relative = relativeWithin(root, target);
  return relative !== undefined && /\S/.test(relative) ? relative : target;
}

function assertNormalizedPath(path: string): void {
  if (!isNormalizedPath(path)) {
    throw new RangeError('Path must use normalized POSIX-style separators.');
  }
}

function isNormalizedPath(path: string): boolean {
  if (path === '' || path === '/') {
    return true;
  }

  const segments = (path.startsWith('/') ? path.slice(1) : path).split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}
