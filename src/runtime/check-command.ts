/**
 * Owns read-only check command composition between CLI parsing and the
 * freshness usecase's filesystem, layout, and reporting boundaries.
 *
 * This runtime path intentionally has no provider, browser, secrets, or event
 * composition. Its dependencies prove that checking committed artifact
 * freshness is independent from the execution machinery used by generation
 * and replay.
 */

import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { readConfigEnvironment } from '#adapters/system/process-config-environment.js';
import { createSystemClock } from '#adapters/system/system-clock.js';
import { loadConfig } from '#config/load.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { AmbercastError } from '#core/errors/types.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { isAbsolutePath, joinPath } from '#core/paths.js';
import { check } from '#usecases/check.js';
import { buildCheckReport, type CheckReportOutput } from '#usecases/check-report.js';
import { createFsTestFileDiscovery } from './test-file-discovery.js';

function reportTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parsed CLI data consumed by the check command runtime.
 */
export interface CheckCommandInput {
  /** Literal prompt paths, or an empty list for configured discovery. */
  readonly files: readonly string[];

  /** Optional configured target override. */
  readonly target?: string;

  /** Whether a genuinely empty inspection is accepted. */
  readonly allowEmpty: boolean;

  /** Whether an empty inspection suppresses exit 5 without changing inspection work. */
  readonly list: boolean;

  /** Optional explicit configuration path. */
  readonly configPathOverride?: string;

  /** Current project directory used for configuration selection. */
  readonly cwd: string;

  /** Optional caller cancellation propagated to freshness inspection. */
  readonly signal?: AbortSignal;
}

/**
 * Rendering-neutral check result returned to the CLI layer.
 */
export interface CheckCommandOutput {
  /** Process result selected by check report policy. */
  readonly exitCode: CheckReportOutput['exitCode'];

  /** Structured report for either JSON serialization or text rendering. */
  readonly envelope: CheckReportOutput['envelope'];
}

/**
 * Runs the composed check command and builds its complete report result.
 *
 * @param input - Parsed command arguments, working directory, and cancellation.
 * @returns A structured envelope and its selected process exit code.
 * @remarks
 * This path composes its read-only dependencies directly instead of using
 * `createAmbercast()`, whose provider and eagerly-created AI executor do not
 * belong to inspection. Converting literal paths to absolute paths here keeps
 * the usecase's path identity independent of the CLI working directory, as
 * it is for generation and replay.
 *
 * The runtime captures report timing around the complete command boundary.
 * Known ambercast errors stay classified, while an unexpected rejection becomes
 * an unexpected-crash report so valid invocations still resolve to the command
 * report and exit-code contract.
 */
export async function runCheckCommand(input: CheckCommandInput): Promise<CheckCommandOutput> {
  const clock = createSystemClock();
  const startedAt = reportTimestamp(clock.now());
  const startedMs = clock.monotonicMs();
  const reportContext = () => ({
    startedAt,
    durationMs: Math.max(0, Math.round(clock.monotonicMs() - startedMs)),
    options: { allowEmpty: input.allowEmpty, list: input.list },
  });

  try {
    const storage = createFsStorage();
    const config = await loadConfig({
      cwd: input.cwd,
      storage,
      configEnv: readConfigEnvironment(),
      ...(input.configPathOverride === undefined ? {} : { configPathOverride: input.configPathOverride }),
    });
    const outcome = await check({
      storage,
      layout: createLayoutResolver(config),
      discoverTestFiles: createFsTestFileDiscovery(),
      config,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }, {
      files: input.files.map((file) => (isAbsolutePath(file) ? file : joinPath(input.cwd, file))),
      ...(input.target === undefined ? {} : { target: input.target }),
      allowEmpty: input.allowEmpty,
      list: input.list,
    });

    return buildCheckReport({ ...reportContext(), outcome });
  } catch (error) {
    const classified = error instanceof AmbercastError
      ? error
      : new UnexpectedCrashError('The check command crashed unexpectedly.', undefined, { cause: error });
    return buildCheckReport({ ...reportContext(), error: classified });
  }
}
