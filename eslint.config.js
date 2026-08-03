/**
 * Provides the repository's ESLint flat configuration. The ordered
 * fragments combine the repository-wide `tseslint.configs.recommended`
 * preset with
 * eslint-plugin-boundaries and production-only `no-restricted-syntax` rules.
 * The determinism and digest restrictions apply only to `src/**`, while
 * deliberately invalid module-graph fixtures below
 * `test/fixtures/architecture/**` are excluded from the ordinary lint run and
 * exercised explicitly by their rule tests. The flat form makes those scopes
 * and ordering visible in one ESM module.
 *
 * The selected preset is `tseslint.configs.recommended`, not
 * `recommendedTypeChecked`: type-aware linting is outside this policy and
 * can slow linting across the repository. eslint-plugin-boundaries
 * translates the shared eleven-role layer policy for
 * prompt editor feedback. Dependency-cruiser evaluates the configured
 * statically resolvable graph edges in CI; the two tools share policy data
 * rather than maintaining separate manually authored layer tables.
 *
 * `no-restricted-syntax` rejects these direct syntax forms outside
 * `src/adapters/system/**`: `Date.now()`, zero-argument `new Date()`,
 * `Math.random()`, `crypto.randomUUID()`, and every `process.env` access,
 * including `process["env"]`. It permits `new Date(value)`. These selectors
 * inspect spelling rather than scope, so a shadowed `Date`, `Math`, `crypto`,
 * or `process` can be an accepted false positive; they document only the
 * direct forms ESLint matches.
 *
 * The digest selector rejects a directly spelled, unaliased
 * `computeInputsDigest` call when its sole argument is not an inline object
 * literal or when that literal contains a spread. Because it is syntax-only,
 * it cannot recognize renamed imports or namespace-qualified calls. It also
 * rejects an unrelated local function with the same written name when called
 * with a bare identifier: that is an accepted ESLint false positive, not a
 * symbol-identity result. The TypeScript-checker scan in
 * `test/architecture.test.ts` resolves declarations instead, catches the
 * aliased and namespace forms, and correctly passes that unrelated local
 * function. The checker scan likewise does not claim to detect derived
 * nondeterminism inside an otherwise valid scalar input.
 */

/**
 * The ordered flat-config fragments ESLint evaluates for this project.
 */
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';
import { LAYERS, NONDETERMINISTIC_GLOBALS } from './tools/architecture-policy.mjs';

/**
 * Production sources constrained by direct nondeterminism and digest-call
 * syntax rules. Tests deliberately construct arbitrary inputs to exercise
 * those APIs, so they remain outside these production-only restrictions.
 */
const ARCHITECTURE_FILES = ['src/**/*.ts'];
const BOUNDARY_FILES = ['src/**/*.ts', 'test/**/*.ts'];
const STANDARD_ADAPTER = LAYERS.adapters;
const HTTP_ADAPTER = STANDARD_ADAPTER.carveOut;

function elementSelector(layer, options = {}) {
  return { element: { type: layer.element.type, ...options } };
}

function importPolicy(target) {
  const targetLayer = LAYERS[target.layer];
  const captured = target.matchingFamily || target.sameFamily
    ? { family: '{{from.family}}' }
    : undefined;

  return {
    to: elementSelector(targetLayer, captured === undefined ? {} : { captured }),
    ...(target.typesOnly ? { dependency: { kind: 'type' } } : {}),
  };
}

function layerPolicy(layer) {
  return {
    from: elementSelector(layer),
    allow: layer.mayImport.map(importPolicy),
  };
}

const boundaryElements = [
  ...Object.values(LAYERS)
    .filter((layer) => layer !== STANDARD_ADAPTER)
    .map((layer) => layer.element),
  HTTP_ADAPTER.element,
  STANDARD_ADAPTER.element,
  STANDARD_ADAPTER.fallbackElement,
];

const boundaryPolicies = [
  ...Object.values(LAYERS)
    .filter((layer) => layer !== STANDARD_ADAPTER)
    .map(layerPolicy),
  {
    from: elementSelector(HTTP_ADAPTER),
    allow: HTTP_ADAPTER.mayImport.map(importPolicy),
  },
  layerPolicy(STANDARD_ADAPTER),
];

const nondeterministicSyntaxRestrictions = NONDETERMINISTIC_GLOBALS.forms.flatMap((form) =>
  form.selectors.map((selector) => ({
    selector,
    message: `${form.name} is available only in adapters/system.`,
  })),
);

const digestInputRestrictions = [
  {
    selector: 'CallExpression[callee.type="Identifier"][callee.name="computeInputsDigest"]:not([arguments.length=1])',
    message: 'computeInputsDigest requires one inline object literal without a spread.',
  },
  {
    selector: 'CallExpression[callee.type="Identifier"][callee.name="computeInputsDigest"][arguments.0.type!="ObjectExpression"]',
    message: 'computeInputsDigest requires one inline object literal without a spread.',
  },
  {
    selector: 'CallExpression[callee.type="Identifier"][callee.name="computeInputsDigest"] > ObjectExpression:has(> SpreadElement)',
    message: 'computeInputsDigest requires one inline object literal without a spread.',
  },
];

export default [
  { ignores: ['test/fixtures/architecture/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
  {
    files: BOUNDARY_FILES,
    plugins: { boundaries },
    settings: {
      'boundaries/elements': boundaryElements,
      'boundaries/elements-single-match': true,
    },
    rules: {
      'boundaries/element-types': ['error', {
        default: 'disallow',
        policies: boundaryPolicies,
      }],
    },
  },
  {
    files: ARCHITECTURE_FILES,
    rules: {
      'no-restricted-syntax': [
        'error',
        ...nondeterministicSyntaxRestrictions,
        ...digestInputRestrictions,
      ],
    },
  },
  {
    files: [NONDETERMINISTIC_GLOBALS.exemptPath],
    rules: {
      'no-restricted-syntax': ['error', ...digestInputRestrictions],
    },
  },
];
