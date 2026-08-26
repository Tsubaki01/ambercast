/**
 * Owns replay command composition at the runtime boundary between CLI parsing
 * and lower-layer configuration, adapters, use cases, and report building.
 *
 * Replay treats provider resolution as a lazy recovery concern, so a fully
 * grounded case does not depend on provider availability or a CLI integration
 * even when configuration selects `auto`.
 */
import { AI_EXECUTOR_FACTORIES } from '#adapters/ai/registry.js';
import { createSpawnCommandRunner } from '#adapters/ai/shared/command-runner.js';
import { createBrowserDriverResolver } from '#adapters/browser/registry.js';
import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { createEnvSecretsProvider } from '#adapters/system/env-secrets-provider.js';
import { createCryptoRandom } from '#adapters/system/crypto-random.js';
import { createNoopEventSink } from '#adapters/system/noop-event-sink.js';
import { createProcessEnvironmentInfo } from '#adapters/system/process-environment-info.js';
import { readCommandEnvironment } from '#adapters/system/process-command-environment.js';
import { readConfigEnvironment } from '#adapters/system/process-config-environment.js';
import { createSystemClock } from '#adapters/system/system-clock.js';
import { loadConfig } from '#config/load.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { AmbercastError, type ExitCode } from '#core/errors/types.js';
import { isAbsolutePath, joinPath } from '#core/paths.js';
import { buildRunReport } from '#usecases/run-report.js';
import type { FinalizedReportEnvelope } from '#usecases/report-finalization.js';
import { finalizeReportEnvelope, isEmergencyFinalizedEnvelope } from '#usecases/report-finalization.js';
import { run } from '#usecases/run.js';
import { createAmbercast } from './create-ambercast.js';
import { resolveAiProvider } from './resolve-ai-provider.js';

/**
 * Converts the wall-clock start instant to the report schema's second-precise
 * UTC timestamp.
 *
 * Report timestamps intentionally omit fractional seconds so independently
 * rendered command output has one stable shape, while monotonic duration
 * measurement remains responsible for elapsed-time precision elsewhere.
 */
function reportTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds the portable filesystem identity shared by one run report and all
 * evidence captured during that invocation.
 *
 * The timestamp keeps artifact directories intelligible in chronological
 * order, while the caller-provided UUID prevents concurrent or same-second
 * runs from sharing a report or screenshot path. Colons are removed because
 * they are illegal in Windows filenames. The resulting timestamp-plus-UUID
 * string satisfies the layout resolver's safe single-segment grammar.
 */
function runIdFor(startedAt: string, uuid: string): string {
  return `${startedAt.replaceAll(':', '')}-${uuid}`;
}

/**
 * Parsed CLI data consumed by the replay command runtime.
 */
export interface RunCommandInput {
  /** Literal prompt paths, or an empty list for configured discovery. */
  readonly files: readonly string[];

  /** Optional already-validated path filter supplied by the CLI parser. */
  readonly grep?: RegExp;

  /** Optional configured target override. */
  readonly target?: string;

  /** Whether browser construction should request visible execution. */
  readonly headed: boolean;

  /**
   * Prevents a replay miss from invoking the lazy AI fallback.
   */
  readonly cacheOnly: boolean;

  /**
   * Records the caller's explicit request to persist this invocation's
   * grounding-cache changes. It is the request an explicit local write-back
   * posture requires before run performs grounding persistence after a case
   * completes, and in CI
   * it independently opts in alongside `ci.updateGroundingCache`.
   */
  readonly updateCache: boolean;

  /**
   * Allows a resolved empty selection to report success.
   *
   * This is reporting policy rather than replay policy, so runtime threads it
   * unchanged to the report builder without allowing it to mask case errors.
   */
  readonly allowEmpty: boolean;

  /**
   * Resolves and reports matching prompt paths without executing cases.
   *
   * Runtime passes this to replay for its early selection boundary and to
   * report construction so an intentional empty list remains successful.
   */
  readonly list: boolean;

  /**
   * Freshness policy accepted by the parser. `regenerate` is a valid enum
   * value but is rejected as `ConfigInvalidError` before file I/O. Replay
   * never eagerly resolves or probes an AI provider and never regenerates a
   * stale artifact, so dropping the flag is a caller-correctable usage fix
   * rather than a new error kind.
   */
  readonly stale: 'fail' | 'regenerate';

  /**
   * Overrides the provider selected only if a replay miss needs AI fallback.
   */
  readonly aiProviderOverride?: 'claude' | 'codex';

  /** Current project directory used for configuration selection. */
  readonly cwd: string;

  /** Optional caller cancellation propagated to replay. */
  readonly signal?: AbortSignal;
}

/**
 * Rendering-neutral result returned to the CLI layer.
 */
export interface RunCommandOutput {
  /** Process result selected by the replay report policy. */
  readonly exitCode: ExitCode;

  /** Structured report for either JSON serialization or text rendering. */
  readonly envelope: FinalizedReportEnvelope;
}

/**
 * Runs the composed `run` command and builds its complete report result.
 *
 * @param input - Parsed command arguments, working directory, and cancellation.
 * @returns A structured envelope and its selected process exit code.
 * @remarks
 * Provider resolution remains lazy through the run use case's fallback port,
 * allowing fully grounded replay to run without an available provider. The
 * command rejects `--stale=regenerate` before file I/O because replay does not
 * regenerate stale artifacts.
 *
 * Every invocation resolves to the documented report and exit-code contract:
 * known ambercast errors remain classified, and other failures become
 * `UnexpectedCrashError` values for report rendering. Only completed outcomes
 * attempt persistence, so every pre-outcome failure remains `not-attempted`,
 * including one after configuration loads. Runtime marks a write candidate
 * `persisted` before I/O so a disk payload never claims that no write was
 * attempted. A failed write returns `failed` without adding an `errors[]`
 * entry: a diagnostic artifact failure must not recast a batch whose cases
 * passed as a report error. It changes only semantic exit code 0 to 3, which
 * preserves the priority of every already-nonzero semantic outcome.
 * Runtime creates one cryptographically random,
 * timestamp-prefixed ID at command start, before composition; after resolved
 * configuration establishes the runs root, it supplies that unchanged ID to
 * every case for evidence paths and then uses it for the single batch report
 * path.
 *
 * Runtime initializes the report-finalization root from `cwd` so failures
 * before configuration still cross the same boundary, then replaces it with
 * `ResolvedConfig.projectRoot` after loading succeeds. Completed replay first
 * finalizes the persisted candidate before writing it. The returned and
 * persisted envelopes are the same finalized value, and an invalid candidate
 * short-circuits before I/O so the emergency report accurately remains
 * `not-attempted`.
 */
export async function runRunCommand(input: RunCommandInput): Promise<RunCommandOutput> {
  let projectRoot = input.cwd;
  const clock = createSystemClock();
  const startedAt = reportTimestamp(clock.now());
  const runId = runIdFor(startedAt, createCryptoRandom().uuid());
  const startedMs = clock.monotonicMs();
  /*
   * Environment detection is composed directly at this command boundary,
   * matching the existing direct randomness adapter. `createAmbercast` owns
   * services shared by command paths, while invocation-specific host facts
   * remain local to the runtime that consumes them.
   */
  const isCI = createProcessEnvironmentInfo().isCI();
  /**
   * Supplies both report paths with one consistent timing and options shape.
   *
   * Both completed and command-error paths use this factory, avoiding
   * independently constructed report-context object literals.
   */
  const reportContext = () => ({
    startedAt,
    durationMs: Math.max(0, Math.round(clock.monotonicMs() - startedMs)),
    options: { allowEmpty: input.allowEmpty, list: input.list },
  });

  try {
    if (input.stale === 'regenerate') {
      throw new ConfigInvalidError(
        'The --stale=regenerate option is unsupported; only --stale=fail is supported.',
      );
    }

    const config = await loadConfig({
      cwd: input.cwd,
      storage: createFsStorage(),
      configEnv: readConfigEnvironment(),
    });
    projectRoot = config.projectRoot;
    const browserDriver = createBrowserDriverResolver({ headed: input.headed });
    const secrets = createEnvSecretsProvider();
    const events = createNoopEventSink();
    const ambercast = createAmbercast({
      config,
      aiProvider: 'claude',
      browserDriver,
      secrets,
      events,
    });
    const outcome = await run({
      storage: ambercast.storage,
      layout: ambercast.layout,
      clock: ambercast.clock,
      runId,
      browserDriver,
      secrets,
      events,
      discoverTestFiles: ambercast.discoverTestFiles,
      config,
      isCI,
      resolveAiExecutor: (signal) => resolveAiProvider(
        config.ai.provider,
        input.aiProviderOverride,
        signal,
      ).then((provider) => AI_EXECUTOR_FACTORIES[provider]({
        run: createSpawnCommandRunner({ env: readCommandEnvironment() }),
      })),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }, {
      files: input.files.map((file) => (isAbsolutePath(file) ? file : joinPath(input.cwd, file))),
      ...(input.grep === undefined ? {} : { grep: input.grep }),
      ...(input.target === undefined ? {} : { target: input.target }),
      cacheOnly: input.cacheOnly,
      updateCache: input.updateCache,
      allowEmpty: input.allowEmpty,
      list: input.list,
      stale: input.stale,
    });

    const built = buildRunReport({ ...reportContext(), outcome });
    const rawPersisted = { ...built.envelope, reportPersistence: 'persisted' as const };
    const rawFailed = { ...built.envelope, reportPersistence: 'failed' as const };
    const finalizedPersisted = finalizeReportEnvelope(rawPersisted, projectRoot);
    if (isEmergencyFinalizedEnvelope(finalizedPersisted)) {
      return { exitCode: 3, envelope: finalizedPersisted };
    }
    try {
      await ambercast.storage.writeText(
        ambercast.layout.runReportPathFor(runId),
        JSON.stringify(finalizedPersisted),
      );
      return { exitCode: built.exitCode, envelope: finalizedPersisted };
    } catch {
      const finalizedFailed = finalizeReportEnvelope(rawFailed, projectRoot);
      const exitCode = isEmergencyFinalizedEnvelope(finalizedFailed) || built.exitCode === 0 ? 3 : built.exitCode;
      return { exitCode, envelope: finalizedFailed };
    }
  } catch (error) {
    const classified = error instanceof AmbercastError
      ? error
      : new UnexpectedCrashError('The run command crashed unexpectedly.', undefined, { cause: error });
    const report = buildRunReport({ ...reportContext(), error: classified });
    const finalized = finalizeReportEnvelope(report.envelope, projectRoot);
    return { exitCode: isEmergencyFinalizedEnvelope(finalized) ? 3 : report.exitCode, envelope: finalized };
  }
}
