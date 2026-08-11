/*
 * Defines pure companion, run-evidence, and batch-report layout arithmetic.
 * Test discovery and `testMatch`/`testIgnore` glob evaluation remain outside
 * this module: a test-discovery use case determines which files are tests,
 * then asks this resolver for their deterministic artifact locations. This
 * module uses one fixed test-file format and one invocation-safe run segment.
 *
 * Construction validates both configured roots and probes the forward and
 * inverse transforms with a synthetic path. The probe confirms that `testDir`
 * is a usable containment boundary; fixed suffix transforms cannot establish
 * any `testMatch` or `testIgnore` semantics.
 */

import type { LayoutConfig } from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { basenamePath, dirnamePath, isAbsolutePath, joinPath, relativeWithin } from '#core/paths.js';

const TEST_SUFFIX = '.test.md';
const PLAN_SUFFIX = '.ambercast.plan.json';
const GROUNDING_SUFFIX = '.ambercast.grounding.json';
const RUN_ID_PATTERN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;

/**
 * Resolves deterministic companion and run-artifact paths for discovered test
 * files under one configured test directory.
 *
 * @remarks
 * Forward methods receive paths that the caller has already established are
 * discovered tests, so invalid input is a caller error reported as a plain
 * `RangeError`. Inverse methods instead support orphan detection, where an
 * unrecognized file is an expected negative answer and therefore yields
 * `undefined` rather than requiring exception handling. A discovered test
 * must have a non-empty name component before `.test.md`; an anonymous
 * `.test.md` file has no valid companion or run-directory mapping.
 */
export interface LayoutResolver {
  /**
   * Derives the plan artifact path for a discovered test file.
   *
   * @param testPath - A discovered test path inside the configured test tree
   *   with a non-empty name component before `.test.md`.
   * @returns The matching plan artifact path.
   * @throws {RangeError} When the path is outside the test tree or does not
   *   end with the exact test suffix or has no name component before it.
   * @remarks
   * The mapping replaces only the terminal test suffix. It does not extract a
   * generic filename stem, because names such as
   * `checkout.mobile.test.md` must retain their meaningful dots.
   */
  planPathFor(testPath: string): string;
  /**
   * Derives the grounding-cache artifact path for a discovered test file.
   *
   * @param testPath - A discovered test path inside the configured test tree
   *   with a non-empty name component before `.test.md`.
   * @returns The matching grounding-cache artifact path.
   * @throws {RangeError} When the path is outside the test tree or does not
   *   end with the exact test suffix or has no name component before it.
   * @remarks
   * Like {@link planPathFor}, the mapping changes an exact terminal suffix
   * rather than applying stem extraction that would mishandle dotted
   * test names.
   */
  groundingPathFor(testPath: string): string;
  /**
   * Locates the dedicated run-artifact directory for a discovered test file.
   *
   * @param testPath - A discovered test path inside the configured test tree
   *   with a non-empty name component before `.test.md`.
   * @param runId - The command invocation identity, made only of one or more
   *   alphanumeric groups separated by single hyphens.
   * @returns The per-test directory under the configured runs directory and
   *   invocation identity.
   * @throws {RangeError} When the path is outside the test tree or does not
   *   end with the exact test suffix or has no name component before it, or
   *   when `runId` is not a single safe path segment.
   * @remarks
   * The invocation segment is outside the case directory so all evidence and
   * the matching batch report share one collision-resistant home. The test's
   * relative directory within `testDir` then follows it, ending with the test
   * name without its terminal `.test.md` suffix. For example, a test at
   * `/project/tests/ui/login.test.md` with `testDir` `/project/tests`,
   * `runsDir` `/project/.runs`, and run ID
   * `2026-08-01T090000Z-550e8400-e29b-41d4-a716-446655440000` maps to
   * `/project/.runs/2026-08-01T090000Z-550e8400-e29b-41d4-a716-446655440000/ui/login`.
   *
   * A per-test directory inside one invocation keeps distinct cases from
   * colliding while preserving an unambiguous batch boundary for evidence.
   * The resolver enforces `^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$`, so a caller cannot
   * use separators, dot segments, or an empty value to alter that boundary.
   */
  runsDirFor(testPath: string, runId: string): string;
  /**
   * Derives the structured batch-report path for one command invocation.
   *
   * @param runId - The command invocation identity accepted by
   *   {@link runsDirFor}.
   * @returns The `report.json` path directly inside that invocation's runs
   *   directory.
   * @throws {RangeError} When `runId` is not a single safe path segment.
   * @remarks
   * A report summarizes the complete invocation rather than one particular
   * test, so it intentionally accepts no `testPath` and has no anonymous or
   * out-of-domain test-path rejection case. Its only caller-controlled path
   * segment is the invocation identity shared with {@link runsDirFor}.
   */
  runReportPathFor(runId: string): string;
  /**
   * Recovers a test path when a file is a recognized plan companion.
   *
   * @param planPath - The discovered path that may be a plan artifact.
   * @returns Its source test path, or `undefined` when it is not a recognized
   *   in-tree plan companion or has no name component before its suffix.
   * @remarks
   * Recognition requires an exact terminal `.ambercast.plan.json` suffix and
   * containment within `testDir`. On success, the resolver removes that
   * terminal suffix and appends `.test.md`; it never replaces a suffix-like
   * substring elsewhere in the name. It returns `undefined` when the path has
   * the wrong suffix, is a grounding companion rather than a plan companion,
   * lies outside `testDir`, or would recover the invalid anonymous
   * `.test.md` path.
   */
  testPathForPlan(planPath: string): string | undefined;
  /**
   * Recovers a test path when a file is a recognized grounding companion.
   *
   * @param groundingPath - The discovered path that may be a grounding cache.
   * @returns Its source test path, or `undefined` when it is not a recognized
   *   in-tree grounding companion or has no name component before its suffix.
   * @remarks
   * Recognition requires an exact terminal `.ambercast.grounding.json` suffix
   * and containment within `testDir`. On success, the resolver removes that
   * terminal suffix and appends `.test.md`; it never replaces a suffix-like
   * substring elsewhere in the name. It returns `undefined` when the path has
   * the wrong suffix, is a plan companion rather than a grounding companion,
   * lies outside `testDir`, or would recover the invalid anonymous
   * `.test.md` path.
   */
  testPathForGrounding(groundingPath: string): string | undefined;
}

/**
 * Creates companion, evidence, and report layout arithmetic for one resolved
 * pair of test and runs paths.
 *
 * @param config - The normalized absolute paths that bound the layout.
 * @returns A resolver that maps known test files and recognized companions.
 * @throws {ConfigInvalidError}
 *   When `testDir` or `runsDir` is not a normalized absolute path, or when
 *   `testDir` cannot support the forward-to-inverse self-check. The thrown
 *   error identifies both configured paths diagnostically and retains the
 *   underlying path error as its cause.
 * @remarks
 * The construction probe maps one synthetic in-tree test path to each
 * companion and back. Construction rejects empty, relative, or dot-segmented
 * configured paths rather than leaving either root to fail when a resolver
 * method is first used. It says nothing about discovery globs because this
 * resolver does not evaluate `testMatch` or `testIgnore`. A discovered test
 * must have a non-empty name component before `.test.md`; an anonymous
 * `.test.md` file has no valid companion or run-directory mapping.
 */
export function createLayoutResolver(config: LayoutConfig): LayoutResolver {
  /**
   * Rejects a caller-controlled invocation identity before it reaches path
   * arithmetic.
   *
   * A report and every case's evidence share this identity, so its valid
   * single-segment form preserves run isolation and prevents caller input
   * from introducing an unbounded hierarchy. Invalid IDs fail with
   * `RangeError`, matching the resolver's other caller-domain violations.
   */
  function assertRunId(runId: string): void {
    if (!RUN_ID_PATTERN.test(runId)) {
      throw new RangeError('Expected runId to be a non-empty safe path segment.');
    }
  }

  /**
   * Converts a known discovered test into its test-root-relative path.
   *
   * The forward mappings all share this check so a boundary mistake cannot
   * produce a companion or evidence path outside the configured test domain.
   * Unlike inverse recognition, malformed input is a caller contract breach
   * and therefore throws `RangeError` instead of returning an ambiguous value.
   */
  function discoveredTestPathRelativeToTestDir(testPath: string): string {
    const relativeTestPath = relativeWithin(config.testDir, testPath);

    if (relativeTestPath === undefined || !testPath.endsWith(TEST_SUFFIX)) {
      throw new RangeError('Expected a discovered test path within testDir ending in .test.md.');
    }

    if (basenamePath(testPath) === TEST_SUFFIX) {
      throw new RangeError('Expected a discovered test path with a name before .test.md.');
    }

    return relativeTestPath;
  }

  /**
   * Replaces a recognized test suffix without discarding a meaningful dotted
   * filename prefix.
   *
   * Companion files remain adjacent to their prompts so moving a test tree
   * preserves both the artifact relationship and the resolver's inverse
   * round-trip guarantee.
   */
  function companionPathFor(testPath: string, companionSuffix: string): string {
    discoveredTestPathRelativeToTestDir(testPath);

    const testName = basenamePath(testPath);
    return joinPath(dirnamePath(testPath), `${testName.slice(0, -TEST_SUFFIX.length)}${companionSuffix}`);
  }

  /**
   * Recognizes one in-tree companion as a source test without treating an
   * arbitrary similarly named file as a validation error.
   *
   * Orphan detection needs ordinary negative answers for wrong suffixes and
   * paths outside the test root, while exact terminal replacement prevents a
   * suffix-like substring from manufacturing a false source test.
   */
  function testPathForCompanion(companionPath: string, companionSuffix: string): string | undefined {
    const relativeCompanionPath = relativeWithin(config.testDir, companionPath);

    if (relativeCompanionPath === undefined || !companionPath.endsWith(companionSuffix)) {
      return undefined;
    }

    const companionName = basenamePath(companionPath);
    if (companionName === companionSuffix) {
      return undefined;
    }

    return joinPath(dirnamePath(companionPath), `${companionName.slice(0, -companionSuffix.length)}${TEST_SUFFIX}`);
  }

  const resolver: LayoutResolver = {
    planPathFor(testPath: string): string {
      return companionPathFor(testPath, PLAN_SUFFIX);
    },
    groundingPathFor(testPath: string): string {
      return companionPathFor(testPath, GROUNDING_SUFFIX);
    },
    runsDirFor(testPath: string, runId: string): string {
      assertRunId(runId);
      const relativeTestPath = discoveredTestPathRelativeToTestDir(testPath);
      const relativeRunsDirectory = joinPath(
        dirnamePath(relativeTestPath),
        basenamePath(relativeTestPath).slice(0, -TEST_SUFFIX.length),
      );

      return joinPath(joinPath(config.runsDir, runId), relativeRunsDirectory);
    },
    runReportPathFor(runId: string): string {
      assertRunId(runId);
      return joinPath(joinPath(config.runsDir, runId), 'report.json');
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

    if (!isAbsolutePath(config.runsDir)) {
      throw new RangeError('runsDir must be absolute.');
    }

    const probeTestPath = joinPath(config.testDir, `__ambercast_layout_selfcheck__${TEST_SUFFIX}`);
    const planRoundTrip = resolver.testPathForPlan(resolver.planPathFor(probeTestPath));
    const groundingRoundTrip = resolver.testPathForGrounding(resolver.groundingPathFor(probeTestPath));

    if (planRoundTrip !== probeTestPath || groundingRoundTrip !== probeTestPath) {
      throw new RangeError('testDir cannot support layout round trips.');
    }
  } catch (error) {
    throw new ConfigInvalidError(
      'Layout configuration has an invalid testDir or runsDir.',
      { testDir: config.testDir, runsDir: config.runsDir },
      { cause: error },
    );
  }

  return resolver;
}
