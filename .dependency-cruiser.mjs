/**
 * Supplies dependency-cruiser's ESM rule set by translating the layer and
 * external-specifier data from tools/architecture-policy.mjs. This avoids a
 * second independently maintained boundary matrix. The resulting rules check
 * configured external specifiers and statically resolvable module-graph
 * edges; they do not claim to resolve arbitrary computed dynamic imports.
 *
 * The configuration sets `options.tsPreCompilationDeps` to
 * `"specify"` once, alongside the repository `tsconfig.json`. That option
 * makes pre-compilation dependency information available; it does not permit
 * type imports on its own. Each types-only table edge instead has a forbidden
 * rule with `to.preCompilationOnly: false`, which fires for a value edge and
 * leaves a pre-compilation-only type edge exempt. Those qualified edges are
 * `ports` -> `core`, `usecases` -> `ports`, `report` -> `core`, and
 * `config` -> `ports`.
 *
 * Dependency-cruiser forbids `config` -> `ports` value imports and allows
 * type-only imports. Its available path and dependency-type conditions do not
 * provide symbol-level resolution, so the type-only exemption cannot be
 * restricted to the `Storage` type; this intentionally coarser approximation
 * is the configuration's stable contract.
 *
 * The generic adapter matcher excludes `src/adapters/http/**`; HTTP has its
 * own runtime-consumer rule permitting only `adapters/http` -> `runtime`.
 * Conversely, runtime's concrete-adapter target matcher excludes HTTP. This
 * leaves neither direction of a runtime/HTTP-adapter cycle inside the generic
 * adapter allowance. Core's external policy permits only `zod`,
 * `node:crypto`, and `node:buffer`, while denying `playwright*` and the
 * normalized builtin families `node:fs`, `node:child_process`, `node:net`,
 * and `node:http` (including bare and subpath spellings such as
 * `node:fs/promises`). AI adapters invoke CLI subprocesses instead of
 * importing an AI SDK, making `node:child_process` the relevant core risk
 * path. `build-tools` has a distinct external allowance of `node:fs`,
 * `node:path`, and `node:url`.
 *
 * The rule identifiers are pinned as `core-is-leaf`,
 * `core-external-allowlist`, `usecases-no-concrete-adapters`,
 * `cli-must-go-through-runtime`, `adapters-no-sibling-reachover`,
 * `adapters-http-runtime-only`, `ports-core-types-only`,
 * `usecases-ports-types-only`, `report-core-types-only`, and
 * `config-ports-types-only`. `test/unit/architecture/dependency-cruiser-rules.test.ts`
 * asserts these exact IDs, so renaming one is an intentional contract change.
 */

/**
 * The dependency-cruiser configuration consumed by the CLI and fixture tests.
 * Its rule set derives from the shared policy, so CLI and fixture consumers
 * exercise the same generated policy projection.
 */
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import {
  CORE_EXTERNAL_ALLOW,
  CORE_EXTERNAL_DENY_PATTERNS,
  LAYERS,
} from './tools/architecture-policy.mjs';

const CONFIG_DIRECTORY = fileURLToPath(new URL('./', import.meta.url));
const TSCONFIG_FILE = relative(
  CONFIG_DIRECTORY,
  fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
);

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function externalSpecifierPattern(specifier) {
  if (specifier.endsWith('*')) {
    const packagePrefix = escapedPattern(specifier.slice(0, -1));
    const packageRoot = `(?:${packagePrefix}|node_modules/${packagePrefix})[^/]*`;
    return `(?:${packageRoot}|${packageRoot}/.+)`;
  }

  if (specifier.startsWith('node:')) {
    const builtinRoot = `(?:node:)?${escapedPattern(specifier.slice('node:'.length))}`;
    return `(?:${builtinRoot}|${builtinRoot}/.+)`;
  }

  const packageName = escapedPattern(specifier);
  const packageRoot = packageName;
  return `(?:${packageRoot}|${packageRoot}/.+)`;
}

function anyExternalSpecifier(values) {
  return values.map(externalSpecifierPattern).join('|');
}

/**
 * Matches resolved npm targets at a package-path boundary. Dependency-cruiser
 * checks those paths after resolution, while unresolved package targets keep
 * the bare specifier matched by externalSpecifierPattern.
 */
function resolvedNpmPackagePathPattern(specifier) {
  const packageName = escapedPattern(specifier.endsWith('*') ? specifier.slice(0, -1) : specifier);
  const packageRoot = specifier.endsWith('*') ? `${packageName}[^/]*` : packageName;
  return `(?:^|/)node_modules/${packageRoot}(?:/|$)`;
}

function typesOnlyEdge(name, from, to) {
  return {
    name,
    severity: 'error',
    from: { path: from.path },
    to: { path: to.path, preCompilationOnly: false },
  };
}

const coreExternalAllowPattern = anyExternalSpecifier(CORE_EXTERNAL_ALLOW);
const coreExternalAllowPackagePaths = CORE_EXTERNAL_ALLOW
  .filter((specifier) => !specifier.startsWith('node:'))
  .map(resolvedNpmPackagePathPattern);
const standardAdapter = LAYERS.adapters;
const httpAdapter = standardAdapter.carveOut;

if (CORE_EXTERNAL_DENY_PATTERNS.some((pattern) => CORE_EXTERNAL_ALLOW.includes(pattern))) {
  throw new Error('Core external allow and deny policies must not overlap.');
}

/**
 * The dependency-cruiser configuration consumed by the CLI and fixture tests.
 * Its rule set derives from the shared policy, so CLI and fixture consumers
 * exercise the same generated policy projection.
 */
export default {
  forbidden: [
    {
      name: 'core-is-leaf',
      severity: 'error',
      from: { path: LAYERS.core.path },
      to: { path: '^src/', pathNot: LAYERS.core.path },
    },
    {
      name: 'core-external-allowlist',
      severity: 'error',
      from: { path: LAYERS.core.path },
      to: {
        pathNot: ['^src/', `^(?:${coreExternalAllowPattern})$`, ...coreExternalAllowPackagePaths],
      },
    },
    {
      name: 'usecases-no-concrete-adapters',
      severity: 'error',
      from: { path: LAYERS.usecases.path },
      to: { path: standardAdapter.path },
    },
    {
      name: 'cli-must-go-through-runtime',
      severity: 'error',
      from: { path: [LAYERS.cli.path, httpAdapter.path] },
      to: { path: '^src/', pathNot: LAYERS.runtime.path },
    },
    {
      name: 'adapters-no-sibling-reachover',
      severity: 'error',
      from: { path: standardAdapter.path, pathNot: httpAdapter.path },
      to: {
        path: '^src/',
        pathNot: [
          LAYERS.core.path,
          '^src/adapters/$1(?:/|$)',
          '^src/ports/$1\\.ts$',
          '^src/ports/index\\.ts$',
        ],
      },
    },
    {
      name: 'adapters-http-runtime-only',
      severity: 'error',
      from: { path: LAYERS.runtime.path },
      to: { path: httpAdapter.path },
    },
    typesOnlyEdge('ports-core-types-only', LAYERS.ports, LAYERS.core),
    typesOnlyEdge('usecases-ports-types-only', LAYERS.usecases, LAYERS.ports),
    typesOnlyEdge('report-core-types-only', LAYERS.report, LAYERS.core),
    typesOnlyEdge('config-ports-types-only', LAYERS.config, LAYERS.ports),
  ],
  options: {
    tsPreCompilationDeps: 'specify',
    tsConfig: { fileName: TSCONFIG_FILE },
  },
};
