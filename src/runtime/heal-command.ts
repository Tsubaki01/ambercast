/**
 * Declares healing command composition between CLI parsing and the healing
 * usecase's confirmation, commit, and reporting boundaries.
 *
 * The command keeps candidate measurement separate from persistence: the
 * usecase returns buffered commit capabilities, and this runtime owns the
 * caller authorization required before any capability is invoked.
 */

import { AI_EXECUTOR_FACTORIES } from '#adapters/ai/registry.js';
import { createSpawnCommandRunner } from '#adapters/ai/shared/command-runner.js';
import { createBrowserDriverResolver } from '#adapters/browser/registry.js';
import { createFsStorage } from '#adapters/storage/fs-storage.js';
import { createConfirmationAnswerReader, type ConfirmationAnswerReader } from '#adapters/system/confirmation-answer-reader.js';
import { createCryptoRandom } from '#adapters/system/crypto-random.js';
import { createEnvSecretsProvider } from '#adapters/system/env-secrets-provider.js';
import { createNoopEventSink } from '#adapters/system/noop-event-sink.js';
import { createProcessEnvironmentInfo } from '#adapters/system/process-environment-info.js';
import { readCommandEnvironment } from '#adapters/system/process-command-environment.js';
import { readConfigEnvironment } from '#adapters/system/process-config-environment.js';
import { createSystemClock } from '#adapters/system/system-clock.js';
import { createTtyInteractivityCheck } from '#adapters/system/tty-interactivity.js';
import { loadConfig } from '#config/load.js';
import { ConfigInvalidError } from '#core/errors/config-invalid-error.js';
import { FsIoError } from '#core/errors/fs-io-error.js';
import { isAbsolutePath, joinPath } from '#core/paths.js';
import { AmbercastError, type ExitCode } from '#core/errors/types.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { heal, type HealBatchResult } from '#usecases/heal.js';
import { buildHealReport, type HealReportOutput } from '#usecases/heal-report.js';
import { createAmbercast } from './create-ambercast.js';
import { resolveAiProvider } from './resolve-ai-provider.js';

import type {
  HealCaseCommit,
  HealCommitOutcome,
  HealDeps,
  HealOutcome,
} from '#usecases/heal.js';

function reportTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function runIdFor(startedAt: string, uuid: string): string {
  return `${startedAt.replaceAll(':', '')}-${uuid}`;
}

/**
 * CLI flags accepted by the healing command.
 *
 * `json` remains a CLI rendering choice, while every other field maps to
 * command composition or the healing usecase. `yes` represents both
 * `--yes` and its `-y` alias.
 */
export interface HealCommandFlags {
  /** Whether candidate plan and grounding writes remain uncommitted. */
  readonly dryRun: boolean;

  /** Whether pending candidate writes are authorized without prompting. */
  readonly yes: boolean;

  /** Whether the CLI renders the returned report as JSON. */
  readonly json: boolean;

  /** Optional explicit target name. */
  readonly target?: string;

  /** Optional provider override used only when healing needs AI work. */
  readonly aiProviderOverride?: 'claude' | 'codex';

  /** Whether an empty discovered selection is a successful outcome. */
  readonly allowEmpty: boolean;

  /** Whether healing returns selected identities without attempting repair. */
  readonly list: boolean;
}

/**
 * Parsed data supplied by the CLI to the healing runtime.
 *
 * File paths remain literal until command composition makes them absolute,
 * following `run-command.ts`'s established `isAbsolutePath`/`joinPath`
 * against `cwd` precedent. Cancellation spans the complete invocation,
 * including confirmation and commit settlement.
 */
export type HealCommandInput = Omit<HealCommandFlags, 'json'> & {
  /** Literal prompt paths, or an empty list for configured discovery. */
  readonly files: readonly string[];

  /** Current project directory used for configuration selection. */
  readonly cwd: string;

  /** Optional caller cancellation propagated to healing. */
  readonly signal?: AbortSignal;
};

/**
 * Runtime capabilities required in addition to the healing usecase surface.
 *
 * `HealDeps` supplies storage, clock, configuration, CI state, discovery,
 * execution ports, and interruption wiring. This command-specific seam makes
 * interactive availability explicit so confirmation policy is testable without
 * relying on a process TTY.
 */
export interface HealCommandDeps extends HealDeps {
  /** Returns whether a confirmation prompt can be presented to this caller. */
  readonly isInteractive: () => boolean;

  /**
   * Obtains authorization for the supplied pending commit capabilities after
   * confirmation policy has decided that an interactive exchange is needed.
   */
  readonly readConfirmationAnswer: ConfirmationAnswerReader;
}

/**
 * Settled result of applying one authorized case commit capability.
 *
 * The case identifier associates a failed commit with the result row it must
 * replace before the final report is built.
 */
export interface HealCommitSettlement {
  /** Stable case identity used as the key in `HealBatchResult.commits`. */
  readonly caseId: string;

  /** Capability that was authorized for this case. */
  readonly commit: HealCaseCommit;

  /** Persistence result reported by the case-local commit capability. */
  readonly result: HealCommitOutcome;
}

/**
 * Rendering-neutral result returned by the healing runtime.
 *
 * The envelope is produced once after authorization and every authorized
 * commit has settled, so failed commits can replace only their own case result
 * with a case-scoped error before report construction.
 */
export interface HealCommandOutput {
  /**
   * Process status selected by `buildHealReport`'s final report policy.
   * That selection incorporates `stage3Error` and `finalReplayError`; this
   * command computes no additional exit-code policy.
   */
  readonly exitCode: ExitCode;

  /** Structured report for either JSON serialization or text rendering. */
  readonly envelope: HealReportOutput['envelope'];
}

/**
 * Requests authorization to persist the listed pending healing candidates.
 *
 * @param commits - Case-local capabilities represented only by their prompt
 * file and neutral repair summary.
 * @returns Whether the caller authorizes every supplied capability.
 * @remarks
 * Confirmation describes the concrete files and repair kinds pending
 * persistence, while deliberately excluding internal stage identity. The
 * report-neutrality rule applies to this user-facing text as well: numbered
 * implementation stages must not become a wording contract merely because a
 * terminal is interactive. This helper decides only whether confirmation is
 * needed; when it is, the command's constructed answer reader performs the
 * short yes/no exchange. That boundary does not introduce a general prompt
 * framework or any additional question types.
 */
export async function promptForHealConfirmation(
  commits: ReadonlyMap<string, HealCaseCommit>,
  input: Pick<HealCommandInput, 'dryRun' | 'yes' | 'signal'>,
  deps: Pick<HealCommandDeps, 'isCI' | 'isInteractive' | 'readConfirmationAnswer'>,
): Promise<boolean> {
  if (commits.size === 0 || input.dryRun || input.yes) {
    return true;
  }

  if (deps.isCI || !deps.isInteractive()) {
    throw new ConfigInvalidError('Healing requires --yes when confirmation cannot be shown.');
  }

  if (input.signal?.aborted === true) {
    return false;
  }

  const candidates = new Map(
    [...commits].map(([caseId, { file, healingSummary }]) => [caseId, { file, healingSummary }]),
  );
  const confirmed = await deps.readConfirmationAnswer(candidates, input.signal);
  return confirmed && !input.signal?.aborted;
}

/**
 * Reconciles authorized commit failures with the usecase's original outcome.
 *
 * @param outcome - The unchanged outcome returned by the healing usecase.
 * @param settlements - Results of every commit attempted after authorization.
 * @returns The original outcome when all commits succeed, or an adjusted
 * outcome whose failed cases move from results to case-scoped errors.
 * @remarks
 * Each failed settlement removes only that case's `HealCaseOutcome` and adds
 * its `FsIoError` as a case-scoped error, retaining the commit result's
 * `partiallyWritten` evidence so the report does not claim the pair of
 * artifacts is coherent when one artifact reached storage. Successfully
 * committed cases retain their result rows exactly as healing measured them;
 * `listed`, `skipped`, `noTestsFound`, and `interrupted` likewise remain batch
 * facts rather than commit bookkeeping.
 *
 * This reconciliation belongs beside confirmation and persistence because it
 * translates a case-local commit capability into the outcome consumed by
 * reporting. `buildHealReport` remains a pure, commit-machinery-unaware
 * boundary, following the separation used by `run-report.ts`: report builders
 * receive settled facts instead of learning how a runtime persisted them.
 */
export function reconcileHealCommitFailures(
  outcome: HealOutcome,
  settlements: readonly HealCommitSettlement[],
): HealOutcome {
  const failures = settlements.filter((settlement): settlement is HealCommitSettlement & {
    readonly result: Extract<HealCommitOutcome, { readonly outcome: 'failed' }>;
  } => settlement.result.outcome === 'failed');
  if (failures.length === 0) {
    return outcome;
  }

  const failedCaseIds = new Set(failures.map(({ caseId }) => caseId));
  return {
    ...outcome,
    results: outcome.results.filter(({ id }) => !failedCaseIds.has(id)),
    errors: [
      ...outcome.errors,
      ...failures.map(({ commit, result }) => {
        const { error, partiallyWritten } = result;
        const persisted = partiallyWritten.length === 0 ? 'no artifacts' : partiallyWritten.join(' and ');
        return {
          file: commit.file,
          error: new FsIoError(
            `Healing artifacts could not be committed after persisting ${persisted}.`,
            { ...(error.details ?? {}), partiallyWritten: [...partiallyWritten] },
            { cause: error },
          ),
        };
      }),
    ],
  };
}

/**
 * Runs the composed healing command and produces its final report result.
 *
 * @param input - Parsed command arguments, working directory, and cancellation.
 * @returns A structured envelope and its selected process exit code.
 * @remarks
 * This composition has one deliberately ordered path. `heal()` owns
 * the early `--list` selection result, so this runtime lets it short-circuit
 * before consulting `ci.heal`; the shared list contract promises discovery
 * without a primary effect and an exit-zero result even when CI healing is
 * disabled. Only a real attempt reaches the `deps.config.ci.heal` refusal
 * gate, then `heal()` measures every case against its private overlay and
 * returns both its outcome and pending commit capabilities. Confirmation must
 * follow that measurement because no earlier boundary can truthfully describe
 * the files and repair kinds pending writes, yet it remains before the
 * first capability invocation so no real artifact write precedes consent.
 *
 * An empty `result.commits` map skips the confirmation gate entirely,
 * regardless of `--yes`/`-y`, interactivity, or CI. With no capability to
 * authorize, this command proceeds directly to report construction from the
 * unchanged outcome.
 *
 * A dry run never prompts and never invokes `commit()`, irrespective of
 * `--yes` or `-y`: the overlay has no plan or grounding change worth
 * authorizing, and the healing usecase's dry-run guarantee already preserves
 * that artifact pair without compensating command logic. The two flag forms
 * are the same pre-authorization. Without either form, a non-interactive
 * caller receives the exit-2 refusal rather than a hidden prompt or implicit
 * write. Interactivity is supplied by the `isInteractive()`/
 * `createTtyInteractivityCheck` seam, not an inline
 * `process.stderr.isTTY` observation, so runtime tests can provide the host
 * fact deterministically and command policy remains independent of Node's
 * process-global state. The same internal composition constructs the
 * confirmation-answer reader
 * before delegating an interactive exchange to the confirmation policy.
 *
 * Cancellation covers the entire invocation rather than only healing. Before
 * an interactive confirmation has obtained consent, including while its yes/no
 * question is pending, no commit capability is called. If cancellation arrives
 * after case processing but before that prompt, the same zero-write outcome
 * preserves already-computed results and skipped identities. With
 * `--yes`/`-y`, authorization predates case processing, so that timing commits
 * exactly the already-terminal cases represented in `result.commits`; cases
 * marked skipped never acquire a capability. Once authorized commit settlement
 * has begun, every eligible capability settles, and a failed case cannot
 * prevent later independent commits; cancellation cannot rewrite an
 * already-started storage settlement into a different batch result.
 *
 * After the authorized capabilities have settled, this boundary first
 * reconciles failed commits and then calls `buildHealReport` exactly once.
 * Building only at that point prevents an initial report from becoming stale,
 * keeps a failed commit case-scoped, and leaves successful or uncommitted
 * measurements unchanged. Before that call, this command boundary rounds only
 * the command-level envelope duration to a non-negative integer, matching
 * `run-command.ts`'s actual precedent exactly. Each case's own
 * `HealCaseOutcome.durationMs` passes through unrounded: that shared,
 * separately tracked issue #197 characteristic is not selectively changed in
 * this command.
 */
export async function runHealCommand(
  input: HealCommandInput,
): Promise<HealCommandOutput> {
  const clock = createSystemClock();
  const startedAt = reportTimestamp(clock.now());
  const runId = runIdFor(startedAt, createCryptoRandom().uuid());
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
    });
    const isCI = createProcessEnvironmentInfo().isCI();
    const browserDriver = createBrowserDriverResolver();
    const secrets = createEnvSecretsProvider();
    const events = createNoopEventSink();
    const ambercast = createAmbercast({
      config,
      aiProvider: 'claude',
      browserDriver,
      secrets,
      events,
    });
    const deps: HealDeps = {
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
    };
    const options = {
      files: input.files.map((file) => (isAbsolutePath(file) ? file : joinPath(input.cwd, file))),
      ...(input.target === undefined ? {} : { target: input.target }),
      dryRun: input.dryRun,
      yes: input.yes,
      allowEmpty: input.allowEmpty,
      list: input.list,
    };

    if (!input.list && isCI && !config.ci.heal) {
      throw new ConfigInvalidError('Healing is disabled in CI; set ci.heal to true to enable it.');
    }

    const result: HealBatchResult = await heal(deps, options);
    const confirmed = await promptForHealConfirmation(result.commits, input, {
      isCI,
      isInteractive: () => createTtyInteractivityCheck()(),
      readConfirmationAnswer: (commits, signal) => createConfirmationAnswerReader()(commits, signal),
    });
    const settlements: HealCommitSettlement[] = [];
    if (!input.dryRun && confirmed) {
      for (const [caseId, commit] of result.commits) {
        try {
          settlements.push({ caseId, commit, result: await commit.commit() });
        } catch (error) {
          settlements.push({
            caseId,
            commit,
            result: {
              outcome: 'failed',
              error: new FsIoError('Healing artifacts could not be committed.', undefined, { cause: error }),
              partiallyWritten: [],
            },
          });
        }
      }
    }

    return buildHealReport({
      ...reportContext(),
      outcome: reconcileHealCommitFailures(result.outcome, settlements),
    });
  } catch (error) {
    const classified = error instanceof AmbercastError
      ? error
      : new UnexpectedCrashError('The heal command crashed unexpectedly.', undefined, { cause: error });
    return buildHealReport({ ...reportContext(), error: classified });
  }
}
