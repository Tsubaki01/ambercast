/**
 * Supplies dependency-cruiser's ESM rule set by translating every role in
 * `LAYERS` from tools/architecture-policy.mjs. This avoids a second,
 * independently maintained boundary matrix. Every role receives an internal
 * default-deny rule derived from `mayImport`; `adapters-http` receives the
 * same treatment from the adapters carve-out. Generated rules are named
 * `<role>-boundary`, except where an existing stable identifier names the
 * generated core, standard-adapter, or CLI boundary. The remaining stable
 * specialized rules have disjoint target sets, so one dependency produces one
 * actionable diagnostic rather than overlapping reports.
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
 * The standard adapter path excludes HTTP, while the HTTP carve-out has its
 * own runtime-consumer boundary. Runtime permits the standard adapter path
 * only, and its dedicated HTTP target rule prevents the opposite half of a
 * cycle. The standard adapter's captured family permits only its matching
 * port-module file; a shared ports index is not an allowance. A flat file at
 * the adapters root cannot represent a family and is therefore subject to a
 * separate no-import rule; this conservative fallback prevents a filename
 * from being used as a fictitious family capture.
 *
 * External allow-lists are also compiled from each role. An approved builtin
 * must resolve with dependency type `core`; an approved package must resolve
 * below its approved `node_modules` root with an npm dependency type.
 * Unresolved dependencies, including fake builtin-looking subpaths, and every
 * other resolved external dependency are forbidden. This relies on
 * dependency-cruiser's resolution facts rather than specifier regexes.
 *
 * The stable rule identifiers are `core-is-leaf`,
 * `core-external-allowlist`, `usecases-no-concrete-adapters`,
 * `cli-must-go-through-runtime`, `adapters-no-sibling-reachover`,
 * `adapters-http-runtime-only`, `ports-core-types-only`,
 * `usecases-ports-types-only`, `report-core-types-only`,
 * `config-ports-types-only`, and `check-no-write-capable-dependencies`.
 * Fixture tests assert these alongside generated boundary names, so changing
 * either convention is an intentional contract change.
 *
 * The check-specific rule uses reachability because its purpose is to
 * keep write-capable dependencies out of the whole check closure, not merely
 * to reject direct imports. Its system-adapter targets remain individual:
 * check-command legitimately needs the clock and configuration-environment
 * adapters in that shared family, so forbidding all of `adapters/system/**`
 * would overreach the read-only capability boundary.
 */

/**
 * The dependency-cruiser configuration consumed by the CLI and fixture tests.
 * Its rule set derives from the shared policy, so CLI and fixture consumers
 * exercise the same generated policy projection.
 */
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';
import { LAYERS } from './tools/architecture-policy.mjs';

const CONFIG_DIRECTORY = fileURLToPath(new URL('./', import.meta.url));
const TSCONFIG_FILE = relative(
  CONFIG_DIRECTORY,
  fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
);

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolvedNpmPackagePathPattern(specifier) {
  const packageName = escapedPattern(specifier);
  const packageRoot = packageName;
  return `(?:^|/)node_modules/${packageRoot}(?:/|$)`;
}

function resolvedBuiltinPathPattern(specifiers) {
  const roots = specifiers
    .filter((specifier) => specifier.startsWith('node:'))
    .map((specifier) => `${escapedPattern(specifier.slice('node:'.length))}(?:|/[^/]*)`);

  return roots.length === 0 ? '^$' : `^(?:${roots.join('|')})$`;
}

function allowedTargetPatterns(layer) {
  return layer.mayImport.map((target) => {
    if (target.sameFamily) {
      return '^src/adapters/$1(?:/|$)';
    }

    if (target.matchingFamily) {
      return '^src/ports/$1\\.ts$';
    }

    return LAYERS[target.layer].path;
  });
}

function internalBoundaryRule(name, layer, additionalAllowedPaths = []) {
  const permittedTargets = [...allowedTargetPatterns(layer), ...additionalAllowedPaths];

  return {
    name,
    severity: 'error',
    from: { path: layer.path },
    to: {
      path: '^src/',
      ...(permittedTargets.length === 0 ? {} : { pathNot: permittedTargets }),
    },
  };
}

function noImportsRule(name, path) {
  return {
    name,
    severity: 'error',
    from: { path },
    to: {},
  };
}

function typesOnlyEdge(name, from, to) {
  return {
    name,
    severity: 'error',
    from: { path: from.path },
    to: { path: to.path, preCompilationOnly: false },
  };
}

const standardAdapter = LAYERS.adapters;
const httpAdapter = standardAdapter.carveOut;
const standardAdapterOrRootFilePath = `(?:${standardAdapter.path}|${standardAdapter.fallbackPath})`;
const NPM_DEPENDENCY_TYPES = [
  'npm',
  'npm-bundled',
  'npm-dev',
  'npm-no-pkg',
  'npm-optional',
  'npm-peer',
  'npm-unknown',
];
const TYPE_ONLY_RULE_NAMES = Object.freeze({
  'config:ports': 'config-ports-types-only',
  'ports:core': 'ports-core-types-only',
  'report:core': 'report-core-types-only',
  'usecases:ports': 'usecases-ports-types-only',
});

function externalAllowRules(role, layer) {
  const allowed = layer.externalAllow ?? [];
  const allowedNpmPackagePaths = allowed
    .filter((specifier) => !specifier.startsWith('node:'))
    .map(resolvedNpmPackagePathPattern);
  const name = `${role}-external-allowlist`;
  const from = { path: layer.path };

  return [
    {
      name,
      severity: 'error',
      from,
      to: { couldNotResolve: true },
    },
    {
      name,
      severity: 'error',
      from,
      to: {
        couldNotResolve: false,
        dependencyTypes: ['core'],
        pathNot: resolvedBuiltinPathPattern(allowed),
      },
    },
    {
      name,
      severity: 'error',
      from,
      to: {
        couldNotResolve: false,
        dependencyTypes: NPM_DEPENDENCY_TYPES,
        pathNot: allowedNpmPackagePaths.length === 0 ? '^$' : allowedNpmPackagePaths,
      },
    },
    {
      name,
      severity: 'error',
      from,
      to: {
        couldNotResolve: false,
        dependencyTypesNot: ['core', ...NPM_DEPENDENCY_TYPES],
        pathNot: '^src/',
      },
    },
  ];
}

const roleBoundaryNames = Object.freeze({
  adapters: 'adapters-no-sibling-reachover',
  cli: 'cli-must-go-through-runtime',
  core: 'core-is-leaf',
});
const specializedBoundaryTargetPaths = Object.freeze({
  runtime: [httpAdapter.path],
  usecases: [standardAdapterOrRootFilePath],
});
const declaredRoles = [
  ...Object.entries(LAYERS),
  ['adapters-http', httpAdapter],
];
const internalBoundaryRules = declaredRoles.map(([role, layer]) => internalBoundaryRule(
  roleBoundaryNames[role] ?? `${role}-boundary`,
  layer,
  specializedBoundaryTargetPaths[role] ?? [],
));
const adaptersRootFileRule = noImportsRule(
  'adapters-root-files-no-imports',
  standardAdapter.fallbackPath,
);
const typesOnlyRules = Object.entries(LAYERS).flatMap(([role, layer]) => layer.mayImport
  .filter((target) => target.typesOnly)
  .map((target) => typesOnlyEdge(
    TYPE_ONLY_RULE_NAMES[`${role}:${target.layer}`] ?? `${role}-${target.layer}-types-only`,
    layer,
    LAYERS[target.layer],
  )));
const externalAllowlistRules = Object.entries(LAYERS)
  .filter(([, layer]) => layer.externalAllow !== undefined)
  .flatMap(([role, layer]) => externalAllowRules(role, layer));

/**
 * The dependency-cruiser configuration consumed by the CLI and fixture tests.
 * Its rule set derives from the shared policy, so CLI and fixture consumers
 * exercise the same generated policy projection.
 */
export default {
  forbidden: [
    ...internalBoundaryRules,
    adaptersRootFileRule,
    {
      name: 'usecases-no-concrete-adapters',
      severity: 'error',
      from: { path: LAYERS.usecases.path },
      to: { path: standardAdapterOrRootFilePath },
    },
    {
      name: 'adapters-http-runtime-only',
      severity: 'error',
      from: { path: LAYERS.runtime.path },
      to: { path: httpAdapter.path },
    },
    {
      /*
       * Check's guarantee covers every dependency reachable from its three
       * entry modules. The `reachable: true` restriction therefore
       * guards the transitive closure; a direct-edge path rule would leave an
       * intermediate module able to smuggle in a forbidden capability.
       *
       * Secrets and the event sink are listed as individual system adapters
       * rather than banning their shared family. The command legitimately
       * depends on system-clock and process-config-environment, so a family
       * ban would reject required read-only composition along with the
       * capabilities this rule is meant to exclude.
       */
      name: 'check-no-write-capable-dependencies',
      severity: 'error',
      from: { path: '^src/(usecases/check(?:-report)?\\.ts|runtime/check-command\\.ts)$' },
      to: {
        path: [
          '^src/adapters/ai(?:/|$)',
          '^src/adapters/browser(?:/|$)',
          '^src/adapters/system/env-secrets-provider\\.ts$',
          '^src/adapters/system/noop-event-sink\\.ts$',
          '^src/adapters/storage/fs-storage\\.ts$',
        ],
        reachable: true,
      },
    },
    ...typesOnlyRules,
    ...externalAllowlistRules,
  ],
  options: {
    tsPreCompilationDeps: 'specify',
    tsConfig: { fileName: TSCONFIG_FILE },
  },
};
