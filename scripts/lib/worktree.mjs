import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Reports a top-level command failure without interrupting control flow.
 *
 * @remarks
 * Helpers throw instead because this function only sets an exit code; each
 * top-level caller immediately returns after calling it to prevent a rejected
 * lifecycle transition from continuing.
 *
 * @param {string} toolName - Name used to prefix the diagnostic.
 * @param {string} message - Human-readable failure diagnostic.
 * @returns {void}
 * @example
 * fail('worktree-add', 'Target directory already exists.');
 */
export function fail(toolName, message) {
  console.error(`${toolName}: ${message}`);
  process.exitCode = 1;
}

/**
 * Converts an unknown thrown value into a displayable diagnostic.
 *
 * @param {unknown} error - Value caught from an operation.
 * @returns {string} The error message for `Error` values, otherwise a string representation.
 * @example
 * getErrorMessage(new Error('Git failed'));
 */
export function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs Git with the shared text-output defaults used by the lifecycle scripts.
 *
 * @param {string[]} args - Git arguments excluding the executable name.
 * @param {Omit<import('node:child_process').ExecFileSyncOptions, 'encoding' | 'stdio'>} [options={}] - Options that override shared defaults without changing text output.
 * @returns {string} Git standard output decoded as UTF-8.
 * @throws {Error} If Git cannot be executed or exits unsuccessfully.
 * @example
 * runGit(['worktree', 'list', '--porcelain']);
 */
export function runGit(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

/**
 * Parses Git's NUL-delimited worktree inventory without performing I/O.
 *
 * @remarks
 * The parser consumes `git worktree list --porcelain -z`: its
 * double-NUL entry boundary and raw attribute records preserve lock reasons
 * exactly, including spaces and newlines. The ordinary porcelain form quotes
 * and escapes those reasons, so using it would corrupt evidence that must be
 * supplied verbatim when a failed removal restores a lock. Unknown attributes
 * remain deliberately forward-compatible rather than becoming a reason to
 * reject an otherwise usable inventory.
 *
 * @param {string} output - NUL-delimited output from `git worktree list --porcelain -z`.
 * @returns {{ path: string, branch?: string, locked?: true | string }[]} Parsed worktree records; a bare `locked` becomes `true`, unknown attributes are ignored, empty input returns an empty array, and a final record need not end in a separator.
 * @example
 * parseWorktreePorcelain('worktree /repo\\0branch refs/heads/main\\0\\0');
 */
export function parseWorktreePorcelain(output) {
  const worktrees = [];
  let worktree;

  for (const record of output.split('\0')) {
    if (record === '') {
      if (worktree !== undefined) {
        worktrees.push(worktree);
        worktree = undefined;
      }
      continue;
    }

    if (record.startsWith('worktree ')) {
      worktree = { path: record.slice('worktree '.length) };
      continue;
    }

    if (worktree !== undefined && record.startsWith('branch refs/heads/')) {
      worktree.branch = record.slice('branch refs/heads/'.length);
      continue;
    }

    if (worktree !== undefined && record === 'locked') {
      worktree.locked = true;
      continue;
    }

    if (worktree !== undefined && record.startsWith('locked ')) {
      worktree.locked = record.slice('locked '.length);
    }
  }

  if (worktree !== undefined) {
    worktrees.push(worktree);
  }

  return worktrees;
}

/**
 * Lists Git worktrees through the shared NUL-safe porcelain parser.
 *
 * @remarks
 * I/O stays outside the parser so unit tests can cover inventory edge cases
 * without a repository. `worktree-add` inventories once, while
 * `worktree-remove` inventories once before its mutex to discover the
 * receptacle and again after acquiring it as authoritative state.
 *
 * @returns {{ path: string, branch?: string, locked?: true | string }[]} Parsed worktree records; a bare `locked` is `true`, unknown attributes are ignored, empty input produces an empty array, and a final record may omit its trailing separator.
 * @throws {Error} If Git fails or reports no worktrees.
 * @example
 * const worktrees = listWorktrees();
 */
export function listWorktrees() {
  const worktrees = parseWorktreePorcelain(runGit(['worktree', 'list', '--porcelain', '-z']));
  if (worktrees.length === 0) {
    throw new Error('Git did not report a main worktree.');
  }

  return worktrees;
}

/**
 * Determines whether an already-realpathed absolute child is the same path as,
 * or lies below, an already-realpathed absolute parent.
 *
 * @remarks
 * The outside test checks the `..` path component boundary (and an
 * absolute relative result), not a bare `startsWith('..')`: a valid child named
 * `..cache` must not be mistaken for an escape. Callers choose the fail-closed
 * policy for an unavailable path; this predicate only states path geometry.
 *
 * @param {string} parent - Already-realpathed absolute path used as the boundary.
 * @param {string} child - Already-realpathed absolute path to compare.
 * @returns {boolean} Whether `child` is `parent` or lies below it.
 * @example
 * isSameOrDescendant('/repos', '/repos/ambercast');
 */
export function isSameOrDescendant(parent, child) {
  const difference = relative(parent, child);
  return difference === '' || !(difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference));
}

/**
 * Determines whether an already-realpathed absolute child lies strictly below
 * an already-realpathed absolute parent.
 *
 * @remarks
 * Strict containment is separate from the inclusive predicate because
 * self-removal rejects the target and everything below it, while receptacle
 * validation must reject the receptacle itself rather than treating it as a
 * managed child.
 *
 * @param {string} parent - Already-realpathed absolute path used as the boundary.
 * @param {string} child - Already-realpathed absolute path to compare.
 * @returns {boolean} Whether `child` lies below, but is not equal to, `parent`.
 * @example
 * isStrictDescendant('/repos', '/repos/ambercast');
 */
export function isStrictDescendant(parent, child) {
  return parent !== child && isSameOrDescendant(parent, child);
}

/**
 * Resolves the command's current directory as a real path without allowing a
 * deleted cwd or a symlink to weaken the self-removal guard.
 *
 * @remarks
 * Both `process.cwd()` and realpath belong in one failure boundary because
 * either can throw. Injectable functions exist only to exercise those otherwise
 * unspawnable failure paths; callers receive the error as data so they can emit
 * a target-specific, fail-closed diagnostic.
 *
 * @param {{ cwdFn?: () => string, realpathFn?: (path: string) => string }} [options={}] - Test-only seam whose functions default to `process.cwd` and `fs.realpathSync`.
 * @returns {{ ok: true, path: string } | { ok: false, error: Error }} A real cwd on success, or the captured cwd-resolution error.
 * @example
 * const cwd = resolveCwdRealpath();
 */
export function resolveCwdRealpath(options = {}) {
  const { cwdFn = process.cwd, realpathFn = realpathSync } = options;
  try {
    return { ok: true, path: realpathFn(cwdFn()) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Classifies a failed removal's target identity and lock evidence, restoring a
 * lock only when fresh evidence identifies an eligible unlocked target.
 *
 * @remarks
 * SPEC-G3a/b for issue #241 classifies the target from fresh Git inventory,
 * physical presence, and branch identity: absent from both is gone; a path
 * present only on disk, registered only in Git, or registered for a different
 * branch is unknown; the remaining same-path, same-branch, present case is
 * eligible for locking. An existing lock short-circuits only when it exactly
 * equals the expected terminal value, preserving a reason byte-for-byte and
 * treating both an unlocked target and a bare original lock as a bare lock.
 *
 * Injectable functions are a second parameter, following
 * `resolveCwdRealpath(options = {})`, so tests can exercise inventory,
 * presence, and lock-command failures without widening the specified target
 * identity contract. The operation is total: every internal failure becomes
 * `state: 'unknown'` rather than escaping the recovery boundary.
 *
 * @param {{ targetPath: string, expectedBranch?: string, originalLock?: true | string }} target - Target identity and its pre-recovery lock value.
 * @param {{ listWorktreesFn?: typeof listWorktrees, existsFn?: typeof import('node:fs').existsSync, runGitFn?: typeof runGit }} [seams={}] - Test-only functions defaulting to the shared inventory, presence, and Git helpers.
 * @returns {{ state: 'locked' | 'unknown' | 'gone', detail: string }} A terminal state: `locked` confirms the matching lock, `unknown` leaves identity or lock evidence unresolved, and `gone` confirms absence from both inventory and disk. `detail` supplies an operator-facing diagnostic; callers derive mutex and journal disposition from `state === 'locked'`.
 * @example
 * ensureTargetLocked({ targetPath: '/worktrees/issues-241', expectedBranch: 'issues/241' });
 */
export function ensureTargetLocked({ targetPath, expectedBranch, originalLock }, seams = {}) {
  const {
    listWorktreesFn = listWorktrees,
    existsFn = existsSync,
    runGitFn = runGit,
  } = seams;
  let worktrees;

  try {
    worktrees = listWorktreesFn();
  } catch (error) {
    return { state: 'unknown', detail: `Unable to confirm target identity: ${getErrorMessage(error)}` };
  }

  const registeredTarget = worktrees.find((worktree) => worktree.path === targetPath);
  let present;

  try {
    present = existsFn(targetPath);
  } catch (error) {
    return { state: 'unknown', detail: `Unable to confirm target presence: ${getErrorMessage(error)}` };
  }

  if (registeredTarget === undefined) {
    return present
      ? { state: 'unknown', detail: 'target path exists but is no longer a registered worktree' }
      : { state: 'gone', detail: 'target is no longer registered or present' };
  }

  if (!present) {
    return { state: 'unknown', detail: 'target is registered but not present on disk' };
  }

  if (registeredTarget.branch !== expectedBranch) {
    return { state: 'unknown', detail: 'registered branch does not match the expected target identity' };
  }

  const expectedLock = originalLock === undefined || originalLock === true ? true : originalLock;
  if (registeredTarget.locked !== undefined) {
    return registeredTarget.locked === expectedLock
      ? { state: 'locked', detail: 'target remains locked' }
      : { state: 'unknown', detail: 'target is locked but not with the expected reason; leaving it untouched' };
  }

  const lockArgs = ['worktree', 'lock'];
  if (typeof expectedLock === 'string') {
    lockArgs.push('--reason', expectedLock);
  }
  lockArgs.push(targetPath);

  try {
    runGitFn(lockArgs);
  } catch (error) {
    return { state: 'unknown', detail: `failed to restore lock: ${getErrorMessage(error)}` };
  }

  return { state: 'locked', detail: 'lock restoration succeeded' };
}

/**
 * Produces the single operator-facing lock-reason grammar for managed issue
 * worktrees.
 *
 * @remarks
 * The formatter validates the owner instead of accepting
 * arbitrary text, while removal treats a recorded reason as opaque evidence and
 * never attempts to parse it back into ownership metadata.
 *
 * @param {string | number} issue - Issue number placed after `issue-`.
 * @param {string} owner - Owner matching `/^[a-z0-9][a-z0-9._-]*$/i`.
 * @param {string} createdIso - UTC timestamp in ISO 8601 `Z` form.
 * @returns {string} `issue-<N> owner=<owner> created=<ISO8601Z>`.
 * @throws {Error} If `owner` does not match `/^[a-z0-9][a-z0-9._-]*$/i`.
 * @example
 * formatLockReason(235, 'codex', '2026-08-31T00:00:00Z');
 */
export function formatLockReason(issue, owner, createdIso) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(owner)) {
    throw new Error(`Invalid worktree owner: ${owner}`);
  }

  return `issue-${issue} owner=${owner} created=${createdIso}`;
}

/**
 * Resolves the primary checkout's top-level directory from Git's inventory.
 *
 * @remarks
 * Git lists the primary checkout first, which lets this work from a linked
 * worktree without assuming the caller's checkout location.
 *
 * @param {{ path: string }[]} worktrees - Git worktree records with the primary entry first.
 * @returns {string} Absolute top-level path of the primary checkout.
 * @throws {Error} If the inventory is empty or Git cannot resolve the path.
 * @example
 * const main = resolveMainWorktree(listWorktrees());
 */
export function resolveMainWorktree(worktrees) {
  const [mainWorktree] = worktrees;

  if (mainWorktree === undefined) {
    throw new Error('Git did not report a main worktree.');
  }

  return runGit(['-C', mainWorktree.path, 'rev-parse', '--show-toplevel']).trim();
}

/**
 * Resolves the repository-namespaced directory that contains managed worktrees.
 *
 * @remarks
 * A per-product namespace prevents repositories sharing a receptacle from
 * colliding on issue numbers. The override must be absolute so process cwd
 * cannot silently change which managed paths the lifecycle commands protect.
 *
 * @param {string} mainWorktree - Absolute top-level path of the primary checkout.
 * @returns {string} Absolute managed-worktree receptacle for this repository.
 * @throws {Error} If `AMBERCAST_WORKTREE_ROOT` is set to a relative path.
 * @example
 * const receptacle = resolveReceptacle('/repos/ambercast');
 */
export function resolveReceptacle(mainWorktree) {
  const override = process.env.AMBERCAST_WORKTREE_ROOT;

  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new Error('AMBERCAST_WORKTREE_ROOT must be an absolute path.');
    }

    return resolve(override, basename(mainWorktree));
  }

  return resolve(mainWorktree, '..', '..', '.worktrees', basename(mainWorktree));
}
