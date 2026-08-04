/*
 * Defines configuration selection and resolution without granting this layer
 * direct access to the host environment or filesystem. The eventual loader
 * selects an explicit option override first, then an injected environment
 * override, then the nearest `ambercast.config.json` found while walking from
 * cwd toward the root, and finally built-in defaults. An explicitly selected
 * path is terminal: a missing file is a configuration error rather than a
 * reason to discover an ancestor file or silently use defaults.
 *
 * Environment values arrive as optional plain data so loading stays
 * deterministic and testable. Direct `process.env` access is confined to the
 * system-adapter boundary, where one snapshot can be captured before this
 * domain layer validates it. The loader will use explicit per-key policy
 * merging instead of a generic recursive merge: that preserves the intended
 * shallow override contract and avoids adding a second prototype-pollution
 * surface beside the raw schema's strict unknown-key checks.
 */

import type { ConfigEnvSnapshot, ResolvedConfig } from '#core/config/schema.js';
import type { StorageAdapter } from '#ports/storage.js';

/**
 * Names the caller-supplied inputs used to select and load one configuration
 * snapshot.
 *
 * @remarks
 * `cwd` is already an absolute normalized POSIX path. A command-level
 * `configPathOverride` has precedence over the captured environment override,
 * while `storage` keeps discovery and reads independent of a particular
 * filesystem implementation. Omitting `configEnv` has the same effect as an
 * empty environment snapshot; this module never reads `process.env` itself.
 *
 * Both nonempty explicit-path sources, `configPathOverride` and
 * `configEnv.configPathOverride`, must be normalized POSIX-style paths under
 * the {@link import('#core/paths.js')} contract. They may be relative to
 * `cwd` or absolute, but must not contain dot segments, repeated separators,
 * or other non-normalized forms. An empty-string value means that no override
 * was supplied. The eventual loader catches a `RangeError` from either
 * malformed nonempty explicit path and reports a `ConfigInvalidError` instead,
 * so a raw path-helper error never escapes this configuration boundary.
 */
export interface LoadConfigOptions {
  readonly cwd: string;
  /**
   * Selects a configuration file ahead of the environment override when
   * nonempty; it follows this interface's explicit-path contract.
   */
  readonly configPathOverride?: string;
  /**
   * Supplies captured environment data, including an optional explicit path
   * that follows this interface's explicit-path contract.
   */
  readonly configEnv?: ConfigEnvSnapshot;
  readonly storage: StorageAdapter;
}

/**
 * Loads the complete configuration that applies to a project directory.
 *
 * @param options - The absolute project directory, optional explicit
 *   selection inputs, captured environment data, and injected storage.
 * @returns A fresh, readonly configuration whose test and runs roots are
 *   absolute and anchored to the selected config file's directory, or to
 *   `cwd` when no configuration file exists.
 * @throws {import('#core/errors/config-invalid-error.js').ConfigInvalidError} When an explicit option or environment path
 *   names no file; selected text is malformed JSON; a present document fails
 *   RawConfig validation; a supplied targets record is empty; the captured AI
 *   provider is unsupported; a supplied default target does not name a
 *   resolved target; a nonempty explicit path is malformed; or either resolved
 *   path is malformed or contains a dot segment. A JSON parse failure retains
 *   its original `SyntaxError` as this error's `cause`, while RawConfig schema
 *   validation retains the failing Zod issue path or paths in this error's
 *   diagnostic details so callers can identify the invalid key.
 * @throws {Error} When the injected storage cannot read a selected file.
 * @remarks
 * The eventual discovery sequence is command override, environment override,
 * nearest ancestor configuration, then defaults. The first two forms are
 * explicit user selections, so their missing files fail immediately instead
 * of falling through to a less specific source. Relative selection paths are
 * anchored to `cwd`; discovered relative `testDir` and `runsDir` values are
 * instead anchored to the directory containing the selected config file.
 *
 * The eventual merge applies top-level overrides, merges only one level of
 * `ai`, `viewer`, and `ci`, and replaces `targets` as a whole. Atomic target
 * replacement means that when a raw file supplies `targets`, its record
 * entirely replaces `DEFAULT_RAW_CONFIG.targets`: the built-in `web-user`
 * target is gone rather than merged alongside the replacement record. In that
 * case, an omitted file `defaultTarget` also clears the built-in `web-user`
 * default instead of inheriting it, because that name would no longer exist in
 * the replacement record. A file-supplied `defaultTarget` is validated against
 * that replacement record, never against the built-in targets. A missing
 * default target is legal even for multiple targets: choosing among them
 * depends on command-level `--target` information that the loader does not
 * receive.
 *
 * A valid `configEnv.aiProviderRaw` value overrides the merged file/default
 * `ai.provider`, giving this loader the environment-variable portion of the
 * documented precedence chain: command-level `--ai` flag, environment
 * variable, config-file value, then auto-detection. Command-level `--ai`
 * handling is entirely outside this loader; command wiring applies that
 * higher-precedence override to this loader's result. Every returned array and
 * nested object will be newly constructed so neither parsed input nor defaults
 * can be aliased by callers.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
  void options;
  throw new Error('not implemented');
}
