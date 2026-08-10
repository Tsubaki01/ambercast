/**
 * Defines the declarative architecture and determinism policy translated by
 * dependency-cruiser and ESLint. One policy table gives those tools and their
 * fixture tests the same authored layer data, rather than requiring separate
 * manually maintained tables; each translation still checks only the syntax
 * forms or statically resolvable edges its tool supports.
 *
 * The policy is tooling, not product code, so it remains outside `src/` and
 * is never bundled. It covers the eight product layers plus the `public-entry`,
 * `build-tools`, and `global-types` non-product roles. Together, the eleven
 * roles fully classify `src/**`, including the exact `src/global.d.ts`
 * declaration-file path. A role matcher may match zero files; fixture tests
 * validate representative edges, while the ESLint suite verifies each current
 * source file maps to one policy role and none is unknown.
 */

/**
 * Maps each source role to its root matcher and internal import contract. The
 * matchers use a path-segment boundary: a root matches the root and
 * its descendants, never a same-prefix sibling. Thus `src/core` covers
 * `src/core/**`, not `src/core-extra/**`; every `src/**` file must have one,
 * and only one, role classification.
 *
 * The eleven roles have these permissions:
 *
 * - `core` is rooted at `src/core` and may import only `core` internally.
 * - `ports` is rooted at `src/ports` and may import `ports` plus `core` only
 *   through a type-only edge. Its port-module file descriptor captures the
 *   basename as `family`, allowing an adapter family to target only its own
 *   interface file.
 * - `adapters` has mutually exclusive standard and HTTP matchers. The
 *   standard matcher is rooted at `src/adapters/<family>/` and explicitly
 *   excludes the `http` family; it may import `core`, its own adapter family,
 *   and its implemented port module. By convention, that module has the same
 *   base file name as the adapter family: `adapters/storage/**` may import
 *   `ports/storage.ts`, but not `ports/ai.ts` or a different family's port
 *   module. A flat module directly below `src/adapters/` is instead an
 *   `adapters-root-file` fallback with no import permissions: it is malformed
 *   for the family convention, so the safest contract prevents its filename
 *   from becoming a fictitious family. Its `externalAllow` entry is a closed
 *   dependency list because standard adapters are the layer with concrete
 *   external integrations: browser automation, filesystem access, subprocess
 *   execution, and third-party validation libraries. Adapters joins core in
 *   having a closed external-dependency contract; the remaining product roles
 *   (`ports`, `usecases`, `report`, `config`, `runtime`, and `cli`) currently
 *   have none because none imports anything external today. This closed
 *   allowlist applies to that matcher only,
 *   not to the `adapters-http` carve-out, which remains outside this
 *   enforcement. An unrestricted standard-adapter external surface would be
 *   a live enforcement gap. The specialized `src/adapters/http` matcher may
 *   import `runtime` only. The standard adapter policy compares the captured
 *   adapter and port families, and fixture tests exercise that convention
 *   with synthetic names.
 * - `usecases` is rooted at `src/usecases` and may import `core`, `usecases`,
 *   and `report`, plus `ports` through a type-only edge.
 * - `report` is rooted at `src/report` and may import `report` plus `core`
 *   through a type-only edge.
 * - `config` is rooted at `src/config` and may import `config` and `core`.
 *   Its `ports` approximation forbids value imports and allows type-only
 *   imports from any ports module. Dependency-cruiser's available conditions
 *   cannot narrow that type-only exemption to the `Storage` type by symbol.
 * - `runtime` is rooted at `src/runtime` and may import `core`, `ports`,
 *   `usecases`, `config`, `runtime`, and concrete `adapters/**` other than
 *   `adapters/http`; it is the composition point for those concrete adapters.
 * - `cli` is rooted at `src/cli` and may import `runtime` only.
 * - `public-entry` is the exact file `src/index.ts`, classified by a file
 *   category rather than a folder element. It has no default product-layer
 *   target; a public API target, when needed, is an explicit allowance rather
 *   than a catch-all inherited permission.
 * - `build-tools` is rooted at `src/build-tools`; it may import `core` and
 *   has the separate external allowance of `node:fs`, `node:path`, and
 *   `node:url`, rather than inheriting core's external permission.
 * - `global-types` is the exact file `src/global.d.ts`, also classified by a
 *   file category. Its ambient `declare const` declarations have no import
 *   permissions because a global declaration file cannot contain runtime
 *   imports.
 *
 * The standard adapter path excludes HTTP, keeping it non-overlapping with
 * the specialized HTTP role and preventing either direction of a
 * `runtime`/HTTP-adapter cycle from being treated as a generic adapter
 * permission.
 *
 * Cross-layer aliases mirror legal import targets only. There is no `#cli/*`
 * alias because no role may use CLI as a cross-layer target.
 */
export const LAYERS = Object.freeze({
  core: {
    root: 'src/core',
    path: '^src/core(?:/|$)',
    element: { type: 'core', pattern: 'src/core', partialMatch: false },
    mayImport: [{ layer: 'core' }],
    externalAllow: ['zod', 'node:crypto', 'node:buffer'],
  },
  ports: {
    root: 'src/ports',
    path: '^src/ports(?:/|$)',
    element: { type: 'ports', pattern: 'src/ports', partialMatch: false },
    portModule: {
      category: 'ports-module',
      pattern: 'src/ports/(*).ts',
      capture: ['family'],
    },
    mayImport: [{ layer: 'ports' }, { layer: 'core', typesOnly: true }],
  },
  adapters: {
    root: 'src/adapters',
    path: '^src/adapters/(?!http(?:/|$))([^/]+)/',
    element: {
      type: 'adapters',
      pattern: 'src/adapters/*',
      capture: ['family'],
      partialMatch: false,
    },
    fallbackPath: '^src/adapters/[^/]+$',
    fallbackElement: { type: 'adapters-root-file', pattern: 'src/adapters', partialMatch: false },
    mayImport: [
      { layer: 'core' },
      { layer: 'ports', matchingFamily: true },
      { layer: 'adapters', sameFamily: true },
    ],
    externalAllow: [
      'node:child_process',
      'node:crypto',
      'node:fs/promises',
      'node:os',
      'node:path',
      'ajv',
      'ajv-formats',
      'playwright-core',
    ],
    carveOut: {
      root: 'src/adapters/http',
      path: '^src/adapters/http(?:/|$)',
      element: { type: 'adapters-http', pattern: 'src/adapters/http', partialMatch: false },
      mayImport: [{ layer: 'runtime' }],
    },
  },
  usecases: {
    root: 'src/usecases',
    path: '^src/usecases(?:/|$)',
    element: { type: 'usecases', pattern: 'src/usecases', partialMatch: false },
    mayImport: [
      { layer: 'core' },
      { layer: 'ports', typesOnly: true },
      { layer: 'usecases' },
      { layer: 'report' },
    ],
  },
  report: {
    root: 'src/report',
    path: '^src/report(?:/|$)',
    element: { type: 'report', pattern: 'src/report', partialMatch: false },
    mayImport: [{ layer: 'report' }, { layer: 'core', typesOnly: true }],
  },
  config: {
    root: 'src/config',
    path: '^src/config(?:/|$)',
    element: { type: 'config', pattern: 'src/config', partialMatch: false },
    mayImport: [
      { layer: 'config' },
      { layer: 'core' },
      { layer: 'ports', typesOnly: true },
    ],
  },
  runtime: {
    root: 'src/runtime',
    path: '^src/runtime(?:/|$)',
    element: { type: 'runtime', pattern: 'src/runtime', partialMatch: false },
    mayImport: [
      { layer: 'core' },
      { layer: 'ports' },
      { layer: 'adapters' },
      { layer: 'usecases' },
      { layer: 'config' },
      { layer: 'runtime' },
    ],
  },
  cli: {
    root: 'src/cli',
    path: '^src/cli(?:/|$)',
    element: { type: 'cli', pattern: 'src/cli', partialMatch: false },
    mayImport: [{ layer: 'runtime' }],
  },
  'public-entry': {
    root: 'src/index.ts',
    path: '^src/index\\.ts$',
    file: { category: 'public-entry', pattern: 'src/index.ts' },
    mayImport: [],
  },
  'build-tools': {
    root: 'src/build-tools',
    path: '^src/build-tools(?:/|$)',
    element: { type: 'build-tools', pattern: 'src/build-tools', partialMatch: false },
    mayImport: [{ layer: 'core' }],
    externalAllow: ['node:fs', 'node:path', 'node:url'],
  },
  'global-types': {
    root: 'src/global.d.ts',
    path: '^src/global\\.d\\.ts$',
    file: { category: 'global-types', pattern: 'src/global.d.ts' },
    mayImport: [],
  },
});

/**
 * Each role's `externalAllow` is its complete external-dependency contract.
 * Dependency-cruiser accepts an approved Node builtin only when resolution
 * marks it as `core`, and an approved package only when resolution lands below
 * that package's `node_modules` root. Every unresolved or unapproved external
 * dependency is rejected, so a builtin-looking but nonexistent subpath cannot
 * obtain permission from its spelling alone.
 */
/**
 * Describes the five direct syntax forms rejected by ESLint: `Date.now()`, a
 * zero-argument `new Date()`, `Math.random()`, `crypto.randomUUID()`, and any
 * `process.env` member access, including `process["env"]`. `new Date(value)`
 * is outside this rule. The selectors are intentionally syntax-only, so they
 * also report a shadowed identifier with one of those spellings.
 *
 * The restrictions apply only to production files under `src/**`; the
 * direct-form restriction is exempt for `src/adapters/system/**`. General
 * TypeScript linting remains repository wide. This documents the direct forms
 * the rule checks, rather than claiming to detect every source of
 * nondeterminism.
 */
export const NONDETERMINISTIC_GLOBALS = Object.freeze({
  exemptPath: 'src/adapters/system/**',
  forms: [
    {
      name: 'Date.now()',
      selectors: ['CallExpression[callee.object.name="Date"][callee.property.name="now"]'],
    },
    {
      name: 'new Date()',
      selectors: ['NewExpression[callee.name="Date"][arguments.length=0]'],
    },
    {
      name: 'Math.random()',
      selectors: ['CallExpression[callee.object.name="Math"][callee.property.name="random"]'],
    },
    {
      name: 'crypto.randomUUID()',
      selectors: ['CallExpression[callee.object.name="crypto"][callee.property.name="randomUUID"]'],
    },
    {
      name: 'process.env',
      selectors: [
        'MemberExpression[object.name="process"][computed=false][property.name="env"]',
        'MemberExpression[object.name="process"][computed=true][property.value="env"]',
      ],
    },
  ],
});
