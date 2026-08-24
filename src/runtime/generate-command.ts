/**
 * Owns generation command composition at the runtime boundary between CLI
 * argument parsing and lower-layer configuration, adapters, and use cases.
 */

import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { readConfigEnvironment } from '#adapters/system/process-config-environment.js';
import { createNoopEventSink } from '#adapters/system/noop-event-sink.js';
import { createSystemClock } from '#adapters/system/system-clock.js';
import { loadConfig } from '#config/load.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { AmbercastError } from '#core/errors/types.js';
import { isAbsolutePath, joinPath } from '#core/paths.js';
import { generate } from '#usecases/generate.js';
import { normalizeReportEnvelope } from '#usecases/report-normalization.js';
import {
  buildGenerateReport,
  type GenerateReportOutput,
} from '#usecases/generate-report.js';
import { createAmbercast } from './create-ambercast.js';
import { resolveAiProvider } from './resolve-ai-provider.js';

function reportTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Parsed CLI data consumed by the generation command runtime.
 */
export interface GenerateCommandInput {
  /** Literal prompt paths, or an empty list for configured discovery. */
  readonly files: readonly string[];
  /** Whether ambiguities select strict outcome policy. */
  readonly strict: boolean;
  /** Whether fresh plans regenerate. */
  readonly force: boolean;
  /** Whether writes are previewed. */
  readonly dryRun: boolean;
  /** Optional configured target override. */
  readonly target?: string;
  /** Optional command-line provider override. */
  readonly aiProviderOverride?: 'claude' | 'codex';
  /** Whether a zero-match result is accepted. */
  readonly allowEmpty: boolean;
  /** Whether only matching paths are listed. */
  readonly list: boolean;
  /** Optional explicit configuration path. */
  readonly configPathOverride?: string;
  /** Current project directory used for configuration selection. */
  readonly cwd: string;
  /** Optional caller cancellation propagated to generation. */
  readonly signal?: AbortSignal;
}

/**
 * Rendering-neutral result returned to the CLI layer.
 */
export interface GenerateCommandOutput {
  /** Process result selected by the usecase report policy. */
  readonly exitCode: GenerateReportOutput['exitCode'];

  /** Structured report for either JSON serialization or text rendering. */
  readonly envelope: GenerateReportOutput['envelope'];
}

/**
 * Runs the composed `generate` command and builds its complete report result.
 *
 * @param input - Parsed command arguments, working directory, and cancellation.
 * @returns A structured envelope and its selected process exit code.
 * @remarks
 * The runtime loads configuration, resolves one provider, composes
 * `createAmbercast`, and invokes the generation use case. It passes the
 * outcome or classified error, timing, and command policy to
 * {@link buildGenerateReport}, leaving the CLI to choose only JSON versus
 * text rendering. That usecase helper owns report-shape construction while
 * runtime retains provider selection and concrete dependency composition. An
 * unexpected dependency rejection is classified as `unexpected-crash`, so a
 * normal command invocation always resolves within the documented report and
 * exit-code contract.
 *
 * Report identity normalization occurs once at this runtime boundary after
 * report construction. The working directory is the initial project-root
 * fallback for failures before configuration resolves; successful loading
 * replaces it with `ResolvedConfig.projectRoot`. The shared normalizer rewrites
 * only `id`, `file`, `planFile`, `caseId`, `groundingFile`, and `artifactFile`,
 * then recomputes summary from the final visible identities. Both completed
 * and command-error envelopes follow one contract without rewriting messages,
 * hints, reasons, or other diagnostic text.
 */
export async function runGenerateCommand(input: GenerateCommandInput): Promise<GenerateCommandOutput> {
  let projectRoot = input.cwd;
  const clock = createSystemClock();
  const startedAt = reportTimestamp(clock.now());
  const startedMs = clock.monotonicMs();
  const reportContext = () => ({
    startedAt,
    durationMs: Math.max(0, Math.round(clock.monotonicMs() - startedMs)),
    options: {
      strict: input.strict,
      dryRun: input.dryRun,
      allowEmpty: input.allowEmpty,
      list: input.list,
    },
  });

  try {
    const config = await loadConfig({
      cwd: input.cwd,
      storage: createFsStorage(),
      configEnv: readConfigEnvironment(),
      ...(input.configPathOverride === undefined ? {} : { configPathOverride: input.configPathOverride }),
    });
    projectRoot = config.projectRoot;
    const aiProvider = await resolveAiProvider(config.ai.provider, input.aiProviderOverride, input.signal);
    const events = createNoopEventSink();
    const ambercast = createAmbercast({ config, aiProvider, events });
    const outcome = await generate({
      storage: ambercast.storage,
      layout: ambercast.layout,
      aiExecutor: ambercast.aiExecutor,
      events,
      discoverTestFiles: ambercast.discoverTestFiles,
      config,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }, {
      files: input.files.map((file) => (isAbsolutePath(file) ? file : joinPath(input.cwd, file))),
      strict: input.strict,
      force: input.force,
      dryRun: input.dryRun,
      ...(input.target === undefined ? {} : { target: input.target }),
      allowEmpty: input.allowEmpty,
      list: input.list,
    });

    const output = buildGenerateReport({ ...reportContext(), outcome });
    return { ...output, envelope: normalizeReportEnvelope(output.envelope, projectRoot) };
  } catch (error) {
    const classified = error instanceof AmbercastError
      ? error
      : new UnexpectedCrashError('The generate command crashed unexpectedly.', undefined, { cause: error });
    const output = buildGenerateReport({ ...reportContext(), error: classified });
    return { ...output, envelope: normalizeReportEnvelope(output.envelope, projectRoot) };
  }
}
