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
import { readCommandEnvironment } from '#adapters/system/process-command-environment.js';
import { readConfigEnvironment } from '#adapters/system/process-config-environment.js';
import { createSystemClock } from '#adapters/system/system-clock.js';
import { loadConfig } from '#config/load.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { AmbercastError, type ExitCode } from '#core/errors/types.js';
import { isAbsolutePath, joinPath, relativeWithin } from '#core/paths.js';
import { buildRunReport, type RunReportOutput } from '#usecases/run-report.js';
import { run, type RunOutcome } from '#usecases/run.js';
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
 * Produces a report-safe view with schema-valid durations and portable
 * evidence paths.
 *
 * @remarks
 * The system monotonic clock retains sub-millisecond precision for replay, but
 * the public report schema reserves duration fields for non-negative whole
 * milliseconds. Runtime leaves `RunDeps.clock` untouched and rounds only this
 * report-boundary view, preserving the use case's measurement while ensuring
 * CLI JSON always satisfies its published schema. Screenshot paths are also
 * made relative to the configured runs root here, where a report consumer can
 * resolve them without exposing a host filesystem prefix.
 *
 * @param outcome - The completed replay outcome with absolute internal paths.
 * @param runsDir - The resolved absolute root that contains every screenshot.
 * @returns A copy suitable for the public report contract.
 * @throws {Error} When a screenshot does not remain contained by `runsDir`.
 *   That would violate layout composition and must not silently expose an
 *   absolute host path in a structured report.
 */
function reportableOutcome(outcome: RunOutcome, runsDir: string): RunOutcome {
  return {
    ...outcome,
    results: outcome.results.map((caseOutcome) => ({
      ...caseOutcome,
      result: {
        ...caseOutcome.result,
        durationMs: Number.isFinite(caseOutcome.result.durationMs)
          ? Math.max(0, Math.round(caseOutcome.result.durationMs))
          : 0,
        steps: caseOutcome.result.steps.map((step) => {
          if (step.screenshot === undefined) {
            return step;
          }

          const screenshot = relativeWithin(runsDir, step.screenshot);
          if (screenshot === undefined) {
            throw new Error('A screenshot path escaped the configured runs directory.');
          }

          return { ...step, screenshot };
        }),
      },
    })),
  };
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
  readonly envelope: RunReportOutput['envelope'];
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
 * `UnexpectedCrashError` values for report rendering. Once a replay outcome
 * exists, its already-built compact report is persisted best effort beneath
 * its invocation directory; persistence must not replace that result with a
 * new command-level failure. Runtime creates one cryptographically random,
 * timestamp-prefixed ID at command start, before composition; after resolved
 * configuration establishes the runs root, it supplies that unchanged ID to
 * every case for evidence paths and then uses it for the single batch report
 * path. A failure before configuration resolves has no runs root, so it
 * returns its report without attempting persistence.
 */
export async function runRunCommand(input: RunCommandInput): Promise<RunCommandOutput> {
  const clock = createSystemClock();
  const startedAt = reportTimestamp(clock.now());
  const runId = runIdFor(startedAt, createCryptoRandom().uuid());
  const startedMs = clock.monotonicMs();
  const reportContext = () => ({
    startedAt,
    durationMs: Math.max(0, Math.round(clock.monotonicMs() - startedMs)),
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
      stale: input.stale,
    });

    const report = buildRunReport({ ...reportContext(), outcome: reportableOutcome(outcome, config.runsDir) });
    try {
      await ambercast.storage.writeText(ambercast.layout.runReportPathFor(runId), JSON.stringify(report.envelope));
    } catch {
      // A report already exists in memory, so persistence cannot reclassify it.
    }
    return report;
  } catch (error) {
    const classified = error instanceof AmbercastError
      ? error
      : new UnexpectedCrashError('The run command crashed unexpectedly.', undefined, { cause: error });
    return buildRunReport({ ...reportContext(), error: classified });
  }
}
