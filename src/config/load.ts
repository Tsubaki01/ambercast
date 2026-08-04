/*
 * Defines configuration selection and resolution without granting this layer
 * direct access to the host environment or filesystem. The loader selects an
 * explicit option override first, then an injected environment override, then
 * the nearest `ambercast.config.json` found while walking from cwd toward the
 * root, and finally built-in defaults. An explicitly selected path is
 * terminal: a missing file is a configuration error rather than a reason to
 * discover an ancestor file or silently use defaults.
 *
 * Environment values arrive as optional plain data so loading stays
 * deterministic and testable. Direct `process.env` access is confined to the
 * system-adapter boundary, where one snapshot can be captured before this
 * domain layer validates it. The loader uses explicit per-key policy merging
 * instead of a generic recursive merge: that preserves the intended shallow
 * override contract and avoids adding a second prototype-pollution surface
 * beside the raw schema's strict unknown-key checks.
 */

import {
  RawConfig,
  type ConfigEnvSnapshot,
  type RawConfig as RawConfigShape,
  type ResolvedConfig,
} from '#core/config/schema.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { dirnamePath, isAbsolutePath, joinPath } from '#core/paths.js';
import type { StorageAdapter } from '#ports/storage.js';
import { DEFAULT_RAW_CONFIG } from './defaults.js';

const CONFIG_FILE_NAME = 'ambercast.config.json';
const AI_PROVIDERS = new Set(['claude', 'codex', 'auto']);

type AiProvider = ResolvedConfig['ai']['provider'];
type ConfigOverrides = Omit<RawConfigShape, '$schema'>;

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
 * was supplied. The loader catches a `RangeError` from either malformed
 * nonempty explicit path and reports a `ConfigInvalidError` instead, so a raw
 * path-helper error never escapes this configuration boundary.
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
 *   diagnostic details so callers can identify the invalid key. The loader will
 *   reject a raw own `constructor` key through `RawConfig`'s own strict-object
 *   validation, while a raw own `__proto__` key will be rejected earlier by a
 *   dedicated pre-check because Zod silently drops it instead of reporting it as
 *   an unrecognized key.
 * @throws {Error} When the injected storage cannot read a selected file.
 * @remarks
 * The discovery sequence is command override, environment override, nearest
 * ancestor configuration, then defaults. The first two forms are explicit
 * user selections, so their missing files fail immediately instead of falling
 * through to a less specific source. Relative selection paths are anchored to
 * `cwd`; discovered relative `testDir` and `runsDir` values are instead
 * anchored to the directory containing the selected config file.
 *
 * The merge applies top-level overrides, merges only one level of `ai`,
 * `viewer`, and `ci`, and replaces `targets` as a whole. Atomic target
 * replacement means that when a raw file supplies `targets`, its record
 * entirely replaces `DEFAULT_RAW_CONFIG.targets`: the built-in `web-user`
 * target is gone rather than merged alongside the replacement record. In that
 * case, an omitted file `defaultTarget` also clears the built-in `web-user`
 * default instead of inheriting it, because that name might no longer exist in
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
 * handling is outside this loader; command wiring applies that
 * higher-precedence override to this loader's result. Every returned array and
 * nested object is newly constructed so neither parsed input nor defaults can
 * be aliased by callers.
 */
export async function loadConfig(options: LoadConfigOptions): Promise<ResolvedConfig> {
  const selectedPath = await selectConfigPath(options);
  let configRoot = options.cwd;
  let overrides: ConfigOverrides = {};

  if (selectedPath !== undefined) {
    const text = await options.storage.readText(selectedPath);
    const document = parseConfigDocument(text, selectedPath);
    rejectUnsafeRawKeys(document, selectedPath);
    const result = RawConfig.safeParse(document);

    if (!result.success) {
      throw new ConfigInvalidError(
        'Configuration file does not match the expected schema.',
        { configPath: selectedPath, issues: result.error.issues },
      );
    }

    const { $schema: _schema, ...parsedOverrides } = result.data;
    overrides = parsedOverrides;
    configRoot = dirnamePath(selectedPath);
  }

  const targetsReplaced = overrides.targets !== undefined;
  const targets = copyTargets(overrides.targets ?? DEFAULT_RAW_CONFIG.targets);

  if (Object.keys(targets).length === 0) {
    throw new ConfigInvalidError('Configuration must define at least one target.', { configPath: selectedPath });
  }

  const defaultTarget = targetsReplaced
    ? overrides.defaultTarget
    : (overrides.defaultTarget ?? DEFAULT_RAW_CONFIG.defaultTarget);

  if (defaultTarget !== undefined && !Object.hasOwn(targets, defaultTarget)) {
    throw new ConfigInvalidError(
      'Configuration defaultTarget does not name a configured target.',
      { configPath: selectedPath, defaultTarget, targetNames: Object.keys(targets) },
    );
  }

  const aiProviderRaw = options.configEnv?.aiProviderRaw;
  if (aiProviderRaw !== undefined && !AI_PROVIDERS.has(aiProviderRaw)) {
    throw new ConfigInvalidError(
      'Configuration environment AI provider is unsupported.',
      { aiProviderRaw },
    );
  }

  const testDir = resolveConfigDirectory(
    'testDir',
    overrides.testDir ?? DEFAULT_RAW_CONFIG.testDir,
    configRoot,
  );
  const runsDir = resolveConfigDirectory(
    'runsDir',
    overrides.runsDir ?? DEFAULT_RAW_CONFIG.runsDir,
    configRoot,
  );

  const config: ResolvedConfig = {
    testDir,
    runsDir,
    testMatch: [...(overrides.testMatch ?? DEFAULT_RAW_CONFIG.testMatch)],
    testIgnore: [...(overrides.testIgnore ?? DEFAULT_RAW_CONFIG.testIgnore)],
    targets,
    ai: {
      provider: aiProviderRaw === undefined
        ? (overrides.ai?.provider ?? DEFAULT_RAW_CONFIG.ai.provider)
        : aiProviderRaw as AiProvider,
    },
    viewer: {
      port: overrides.viewer?.port ?? DEFAULT_RAW_CONFIG.viewer.port,
    },
    ci: {
      heal: overrides.ci?.heal ?? DEFAULT_RAW_CONFIG.ci.heal,
      updateGroundingCache: overrides.ci?.updateGroundingCache ?? DEFAULT_RAW_CONFIG.ci.updateGroundingCache,
    },
  };

  return defaultTarget === undefined ? config : { ...config, defaultTarget };
}

async function selectConfigPath(options: LoadConfigOptions): Promise<string | undefined> {
  const explicitPath = options.configPathOverride || options.configEnv?.configPathOverride;

  if (explicitPath !== undefined && explicitPath !== '') {
    const selectedPath = resolveExplicitPath(explicitPath, options.cwd);

    if (!await options.storage.exists(selectedPath)) {
      throw new ConfigInvalidError('Selected configuration file does not exist.', { configPath: selectedPath });
    }

    return selectedPath;
  }

  let directory = options.cwd;
  while (true) {
    const candidate = joinPath(directory, CONFIG_FILE_NAME);
    if (await options.storage.exists(candidate)) {
      return candidate;
    }

    const parent = dirnamePath(directory);
    if (parent === directory) {
      return undefined;
    }

    directory = parent;
  }
}

function resolveExplicitPath(path: string, cwd: string): string {
  try {
    return isAbsolutePath(path) ? path : joinPath(cwd, path);
  } catch (error) {
    throw new ConfigInvalidError(
      'An explicit configuration path must be a normalized POSIX path.',
      { configPath: path },
      { cause: error },
    );
  }
}

function parseConfigDocument(text: string, configPath: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ConfigInvalidError(
      'Configuration file contains malformed JSON.',
      { configPath },
      { cause: error },
    );
  }
}

/**
 * The pre-check will reject a raw own `__proto__` key that strict-object parsing
 * does not report as unknown.
 *
 * Zod silently drops this key while parsing a strict object, so the pre-check
 * prevents an untrusted name from crossing the merge boundary. A raw own
 * `constructor` key will be left to `RawConfig`'s own strict-object validation.
 */
function rejectUnsafeRawKeys(document: unknown, configPath: string): void {
  if (document === null || typeof document !== 'object') {
    return;
  }

  for (const key of ['__proto__', 'constructor'] as const) {
    if (Object.prototype.hasOwnProperty.call(document, key)) {
      throw new ConfigInvalidError(
        `Configuration file must not declare an own ${key} key.`,
        { configPath, key },
      );
    }
  }
}

function copyTargets(source: ResolvedConfig['targets']): ResolvedConfig['targets'] {
  return Object.fromEntries(
    Object.entries(source).map(([name, target]) => [name, { ...target }]),
  );
}

function resolveConfigDirectory(field: 'testDir' | 'runsDir', value: string, configRoot: string): string {
  try {
    return isAbsolutePath(value) ? value : joinPath(configRoot, value);
  } catch (error) {
    throw new ConfigInvalidError(
      `Configuration ${field} must resolve to a normalized absolute POSIX path.`,
      { field, value, configRoot },
      { cause: error },
    );
  }
}
