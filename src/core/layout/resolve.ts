/*
 * Defines pure companion-file layout arithmetic for paths already discovered
 * as tests. Test discovery and `testMatch`/`testIgnore` glob evaluation
 * remain outside this module: a test-discovery use case determines which
 * files are tests, then asks this resolver for their deterministic companion
 * locations. This module recognizes only the fixed terminal companion suffixes
 * `.test.md`, `.ambercast.plan.json`, and `.ambercast.grounding.json`.
 *
 * The constructor probes forward and inverse transforms with a synthetic path.
 * That confirms only that `testDir` is a usable absolute,
 * non-empty, dot-segment-free containment boundary; fixed suffix transforms
 * cannot make the probe establish any `testMatch` or `testIgnore` semantics.
 */

import type { LayoutConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { basenamePath, dirnamePath, isAbsolutePath, joinPath, relativeWithin } from '#core/paths.js';

const TEST_SUFFIX = '.test.md';
const PLAN_SUFFIX = '.ambercast.plan.json';
const GROUNDING_SUFFIX = '.ambercast.grounding.json';

/**
 * Resolves deterministic companion and run-artifact paths for discovered test
 * files under one configured test directory.
 *
 * @remarks
 * Forward methods receive paths that the caller has already established are
 * discovered tests, so invalid input is a caller error reported as a plain
 * `RangeError`. Inverse methods instead support orphan detection, where an
 * unrecognized file is an expected negative answer and therefore yields
 * `undefined` rather than requiring exception handling.
 */
export interface LayoutResolver {
  /**
   * Derives the plan artifact path for a discovered test file.
   *
   * @param testPath - A discovered test path inside the configured test tree.
   * @returns The matching plan artifact path.
   * @throws {RangeError} When the path is outside the test tree or does not
   *   end with the exact test suffix.
   * @remarks
   * The mapping replaces only the terminal test suffix. It does not extract a
   * generic filename stem, because names such as
   * `checkout.mobile.test.md` must retain their meaningful dots.
   */
  planPathFor(testPath: string): string;
  /**
   * Derives the grounding-cache artifact path for a discovered test file.
   *
   * @param testPath - A discovered test path inside the configured test tree.
   * @returns The matching grounding-cache artifact path.
   * @throws {RangeError} When the path is outside the test tree or does not
   *   end with the exact test suffix.
   * @remarks
   * Like {@link planPathFor}, the mapping changes an exact terminal suffix
   * rather than applying stem extraction that would mishandle dotted
   * test names.
   */
  groundingPathFor(testPath: string): string;
  /**
   * Locates the dedicated run-artifact directory for a discovered test file.
   *
   * @param testPath - A discovered test path inside the configured test tree.
   * @returns The per-test directory under the configured runs directory.
   * @throws {RangeError} When the path is outside the test tree or does not
   *   end with the exact test suffix.
   * @remarks
   * The result is the test path's relative directory within `testDir`, joined
   * under `runsDir`, then joined with the test's base name after removing only
   * its terminal `.test.md` suffix. Equivalently, for relative test path `p`,
   * it returns `joinPath(runsDir, joinPath(dirnamePath(p),
   * basenamePath(p).slice(0, -TEST_SUFFIX.length)))`. For example, a test at
   * `/project/tests/ui/login.test.md` with `testDir` `/project/tests` and
   * `runsDir` `/project/.runs` maps to `/project/.runs/ui/login`.
   *
   * A per-test directory prevents screenshots, traces, and other artifacts
   * from distinct tests colliding in the bare shared runs directory.
   */
  runsDirFor(testPath: string): string;
  /**
   * Recovers a test path when a file is a recognized plan companion.
   *
   * @param planPath - The discovered path that may be a plan artifact.
   * @returns Its source test path, or `undefined` when it is not a recognized
   *   in-tree plan companion.
   * @remarks
   * Recognition requires an exact terminal `.ambercast.plan.json` suffix and
   * containment within `testDir`. On success, the resolver removes that
   * terminal suffix and appends `.test.md`; it never replaces a suffix-like
   * substring elsewhere in the name. It returns `undefined` when the path has
   * the wrong suffix, is a grounding companion rather than a plan companion,
   * or lies outside `testDir`.
   */
  testPathForPlan(planPath: string): string | undefined;
  /**
   * Recovers a test path when a file is a recognized grounding companion.
   *
   * @param groundingPath - The discovered path that may be a grounding cache.
   * @returns Its source test path, or `undefined` when it is not a recognized
   *   in-tree grounding companion.
   * @remarks
   * Recognition requires an exact terminal `.ambercast.grounding.json` suffix
   * and containment within `testDir`. On success, the resolver removes that
   * terminal suffix and appends `.test.md`; it never replaces a suffix-like
   * substring elsewhere in the name. It returns `undefined` when the path has
   * the wrong suffix, is a plan companion rather than a grounding companion,
   * or lies outside `testDir`.
   */
  testPathForGrounding(groundingPath: string): string | undefined;
}

/**
 * Creates layout arithmetic for one resolved pair of test and runs paths.
 *
 * @param config - The normalized absolute paths that bound the layout.
 * @returns A resolver that maps known test files and recognized companions.
 * @throws {import('../errors/config-invalid-error.js').ConfigInvalidError}
 *   When `testDir` cannot support the forward-to-inverse self-check. The
 *   thrown error identifies `testDir` diagnostically.
 * @remarks
 * The construction probe maps one synthetic in-tree test path to each
 * companion and back. It catches an empty, relative, or dot-segmented
 * `testDir`, but says nothing about discovery globs because this resolver does
 * not evaluate `testMatch` or `testIgnore`.
 */
export function createLayoutResolver(config: LayoutConfig): LayoutResolver {
  function discoveredTestPathRelativeToTestDir(testPath: string): string {
    const relativeTestPath = relativeWithin(config.testDir, testPath);

    if (relativeTestPath === undefined || !testPath.endsWith(TEST_SUFFIX)) {
      throw new RangeError('Expected a discovered test path within testDir ending in .test.md.');
    }

    return relativeTestPath;
  }

  function companionPathFor(testPath: string, companionSuffix: string): string {
    discoveredTestPathRelativeToTestDir(testPath);

    const testName = basenamePath(testPath);
    return joinPath(dirnamePath(testPath), `${testName.slice(0, -TEST_SUFFIX.length)}${companionSuffix}`);
  }

  function testPathForCompanion(companionPath: string, companionSuffix: string): string | undefined {
    const relativeCompanionPath = relativeWithin(config.testDir, companionPath);

    if (relativeCompanionPath === undefined || !companionPath.endsWith(companionSuffix)) {
      return undefined;
    }

    const companionName = basenamePath(companionPath);
    return joinPath(dirnamePath(companionPath), `${companionName.slice(0, -companionSuffix.length)}${TEST_SUFFIX}`);
  }

  const resolver: LayoutResolver = {
    planPathFor(testPath: string): string {
      return companionPathFor(testPath, PLAN_SUFFIX);
    },
    groundingPathFor(testPath: string): string {
      return companionPathFor(testPath, GROUNDING_SUFFIX);
    },
    runsDirFor(testPath: string): string {
      const relativeTestPath = discoveredTestPathRelativeToTestDir(testPath);
      const relativeRunsDirectory = joinPath(
        dirnamePath(relativeTestPath),
        basenamePath(relativeTestPath).slice(0, -TEST_SUFFIX.length),
      );

      return joinPath(config.runsDir, relativeRunsDirectory);
    },
    testPathForPlan(planPath: string): string | undefined {
      return testPathForCompanion(planPath, PLAN_SUFFIX);
    },
    testPathForGrounding(groundingPath: string): string | undefined {
      return testPathForCompanion(groundingPath, GROUNDING_SUFFIX);
    },
  };

  try {
    if (!isAbsolutePath(config.testDir)) {
      throw new RangeError('testDir must be absolute.');
    }

    const probeTestPath = joinPath(config.testDir, `__ambercast_layout_selfcheck__${TEST_SUFFIX}`);
    const planRoundTrip = resolver.testPathForPlan(resolver.planPathFor(probeTestPath));
    const groundingRoundTrip = resolver.testPathForGrounding(resolver.groundingPathFor(probeTestPath));

    if (planRoundTrip !== probeTestPath || groundingRoundTrip !== probeTestPath) {
      throw new RangeError('testDir cannot support layout round trips.');
    }
  } catch {
    throw new ConfigInvalidError('Layout configuration has an invalid testDir.', { testDir: config.testDir });
  }

  return resolver;
}
