/*
 * Defines the single pure target-selection policy shared by generation,
 * replay, and freshness inspection. Keeping precedence in core prevents a
 * command from accepting a target that another command would reject for the
 * same resolved configuration.
 */

import { TargetUnresolvedError } from '#core/errors/target-unresolved-error.js';
import type { TargetDefinition } from '#core/ir/schema.js';
import type { ResolvedTargetConfigEntry } from '#core/config/schema.js';

/**
 * Projects a resolved target to the plan and input-digest target definition.
 *
 * @param target - The fully resolved target, including runtime-only policy.
 * @returns The target fields whose changes define plan freshness.
 * @remarks
 * The projection explicitly picks `baseUrl`, `browser`, and
 * `secretSinkOrigins` rather than relying on a structural cast. In particular,
 * `healReplayIsolation` governs whether healing may start against live state;
 * it must not alter a committed plan or make an otherwise fresh plan stale.
 */
export function toTargetDefinition(target: ResolvedTargetConfigEntry): TargetDefinition {
  return {
    baseUrl: target.baseUrl,
    browser: target.browser,
    ...(target.secretSinkOrigins === undefined ? {} : { secretSinkOrigins: target.secretSinkOrigins }),
  };
}

/**
 * The resolved configuration values and optional caller choice considered by
 * target selection.
 *
 * @remarks
 * `defaultTarget` comes from `loadConfig`, which validates every defined
 * default as an own configured target. An invalid default is therefore outside
 * this public resolver contract rather than a second caller-input error path.
 */
export interface ResolveTargetInput {
  /**
   * Resolved targets whose own keys support named selection and whose
   * enumerable own keys form the implicit-selection domain.
   */
  readonly targets: Readonly<Record<string, Readonly<ResolvedTargetConfigEntry>>>;

  /** The loader-validated default target name, when configuration defines one. */
  readonly defaultTarget: string | undefined;

  /** The caller-supplied target name, when the command explicitly selects one. */
  readonly explicitTarget: string | undefined;
}

/**
 * One selected target and the restricted record exposed to downstream work.
 *
 * @remarks
 * The one-entry `definitions` record keeps unrelated configured targets out of
 * freshness digests and provider context. Its selected definition is also the
 * only target allowed to choose browser behavior, so selection cannot silently
 * broaden AI or browser authority. The record uses own data-property semantics
 * even for special property names, preserving the ordinary object prototype.
 * Both `definition` and `definitions[name]` are `toTargetDefinition`
 * projections. They are never aliases of a resolved target, so configuration-
 * only runtime policy cannot cross into plan or digest consumers.
 */
export interface TargetSelection {
  /** The selected own target name. */
  readonly name: string;

  /** The selected target's digest-bound definition projection. */
  readonly definition: Readonly<TargetDefinition>;

  /** A digest-ready one-entry record containing the same projected definition. */
  readonly definitions: Readonly<Record<string, Readonly<TargetDefinition>>>;
}

/**
 * Selects the configured target shared by generate, run, and check.
 *
 * @param input - Resolved targets, the validated default, and any explicit
 * caller selection.
 * @returns The selected target or a classified target-resolution failure.
 * @remarks
 * An explicit caller choice is authoritative. A missing requested own name
 * fails without falling back to the configured default or an implicit
 * candidate. Without an explicit choice, the loader-validated default has
 * precedence; otherwise the configured targets must supply one unambiguous
 * enumerable own candidate. Only `undefined` denotes absence, so an empty
 * string remains a valid target name through every selection route.
 *
 * Named authority is restricted to own properties, while implicit candidates
 * are restricted to enumerable own properties. Inherited prototype names
 * therefore cannot become configured authority by lookup accident. Stable
 * candidate ordering makes ambiguity diagnostics deterministic. The two
 * failure forms distinguish a missing requested name from an unresolved
 * implicit choice and retain the relevant requested or candidate information.
 *
 * Failures are returned so generation and replay can retain their established
 * per-file classification and continue later files. Freshness inspection
 * throws the same classified value at its command-level selection boundary.
 * The shared `target-unresolved` kind maps to the public
 * `TARGET_UNRESOLVED` code and process exit 2.
 */
export function resolveTarget(
  input: ResolveTargetInput,
): TargetSelection | TargetUnresolvedError {
  const targetNames = Object.keys(input.targets).sort();

  function selection(name: string): TargetSelection {
    const definition = toTargetDefinition(input.targets[name]!);
    const definitions = Object.fromEntries([[name, definition]]);
    return { name, definition, definitions };
  }

  if (input.explicitTarget !== undefined) {
    if (!Object.hasOwn(input.targets, input.explicitTarget)) {
      return new TargetUnresolvedError(
        'The requested target is not configured.',
        { target: input.explicitTarget },
      );
    }

    return selection(input.explicitTarget);
  }

  if (
    input.defaultTarget !== undefined
    && Object.hasOwn(input.targets, input.defaultTarget)
  ) {
    return selection(input.defaultTarget);
  }

  if (targetNames.length === 1) {
    return selection(targetNames[0]!);
  }

  return new TargetUnresolvedError(
    'A target could not be selected from the configured targets.',
    { target: '(default)', targetNames },
  );
}
