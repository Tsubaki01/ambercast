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
import { createRunsDirContainedStorage } from '#adapters/storage/runs-dir-contained-storage.js';
import { createConfirmationAnswerReader, type ConfirmationAnswer, type ConfirmationAnswerReader } from '#adapters/system/confirmation-answer-reader.js';
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
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { isAbsolutePath, joinPath } from '#core/paths.js';
import { AmbercastError, type ExitCode } from '#core/errors/types.js';
import { UnexpectedCrashError } from '#core/errors/unexpected-crash-error.js';
import { resolveTarget } from '#core/target/resolve.js';
import { heal, type HealBatchResult } from '#usecases/heal.js';
import { buildHealReport, type SettledHealOutcome } from '#usecases/heal-report.js';
import type { FinalizedReportEnvelope } from '#usecases/report-finalization.js';
import { finalizeReportEnvelope, isEmergencyFinalizedEnvelope } from '#usecases/report-finalization.js';
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
 * Confirmation state after runtime policy has decided whether asking is needed.
 *
 * `not-required` is added above the terminal adapter because empty commits and
 * dry runs are runtime policy outcomes rather than user input. `--yes` is
 * separately represented as runtime-produced `authorized`.
 */
export type HealConfirmationOutcome = ConfirmationAnswer | 'not-required';

/**
 * Settled result of applying one authorized case commit capability.
 *
 * The case identifier associates a failed commit with the result row that
 * remains in the final report alongside its matching case-scoped error.
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
 * commit has settled, so a failed commit keeps its own result row and adds a
 * matching case-scoped error before report construction.
 */
export interface HealCommandOutput {
  /**
   * Process status selected by `buildHealReport`'s final report policy.
   * That selection incorporates `stage3Error` and `finalReplayError`; an
   * emergency finalization fallback alone replaces it with exit code 3.
   */
  readonly exitCode: ExitCode;

  /** Structured report for either JSON serialization or text rendering. */
  readonly envelope: FinalizedReportEnvelope;
}

/**
 * Requests authorization to persist the listed pending healing candidates.
 *
 * @param commits - Case-local capabilities represented only by their prompt
 * file and neutral repair summary.
 * @returns The explicit authorization state for every supplied capability.
 * @remarks
 * Confirmation describes the concrete files and repair kinds pending
 * persistence, while deliberately excluding internal stage identity. The
 * report-neutrality rule applies to this user-facing text as well: numbered
 * implementation stages must not become a wording contract merely because a
 * terminal is interactive. This helper decides only whether confirmation is
 * needed; when it is, the command's constructed answer reader performs the
 * short exchange. Empty commits and dry runs are not promptable, while `--yes`
 * is pre-authorization; those policy branches return explicit values without
 * consulting the adapter. The adapter itself has only three values so it
 * cannot claim the policy-owned no-prompt state and accidentally authorize a
 * write. Non-interactive callers still receive the existing configuration
 * error rather than a fifth confirmation outcome.
 */
export async function promptForHealConfirmation(
  commits: ReadonlyMap<string, HealCaseCommit>,
  input: Pick<HealCommandInput, 'dryRun' | 'yes' | 'signal'>,
  deps: Pick<HealCommandDeps, 'isCI' | 'isInteractive' | 'readConfirmationAnswer'>,
): Promise<HealConfirmationOutcome> {
  if (commits.size === 0 || input.dryRun) {
    return 'not-required';
  }

  if (input.yes) {
    return 'authorized';
  }

  if (deps.isCI || !deps.isInteractive()) {
    throw new ConfigInvalidError('Healing requires --yes when confirmation cannot be shown.');
  }

  if (input.signal?.aborted === true) {
    return 'interrupted';
  }

  const candidates = new Map(
    [...commits].map(([caseId, { file, healingSummary }]) => [caseId, { file, healingSummary }]),
  );
  return deps.readConfirmationAnswer(candidates, input.signal);
}

/**
 * Produces report-ready outcomes after confirmation and commit settlement.
 *
 * @param outcome - The measured outcome returned by the healing usecase.
 * @param confirmation - The explicit policy or adapter confirmation outcome.
 * @param dryRun - Whether runtime policy intentionally withheld all commits.
 * @param settlements - Results of commit capabilities attempted after authorization.
 * @returns A distinct settled outcome with mandatory report application facts.
 * @remarks
 * The mapping is total and preserves the measurement-owned `stopReason`.
 * `no-changes-needed` is always `'settled'` because its loop never starts.
 * A row without a commit capability retains `no-artifact-change`; in
 * particular, an unresolved row that reached Stage 3 can retain either
 * `'settled'` or `'attempt-limit'` without being reclassified by settlement.
 * A batch-level confirmation for other rows has no effect on these rows:
 *
 * | Measured repair outcome | Per-case settlement | Application |
 * | --- | --- | --- |
 * | no commit capability | absent | `no-artifact-change` |
 *
 * For every commit-capable `healed` or `partially-healed` row, the remaining
 * confirmation and settlement combinations are exhaustive:
 *
 * | Confirmation | `dryRun` | Per-case settlement | Application |
 * | --- | --- | --- |
 * | `not-required` | `true` | absent | `preview-only` |
 * | `authorized` | `false` | `committed` | `applied` |
 * | `authorized` | `false` | `failed`, `partiallyWritten` empty | `apply-failed` |
 * | `authorized` | `false` | `failed`, `partiallyWritten` non-empty | `partially-applied` |
 * | `declined` | `false` | absent | `declined` |
 * | `interrupted` | `false` | absent | `not-applied-interrupted` |
 *
 * The function throws `UnexpectedCrashError` for every omitted combination:
 * a settlement for `no-changes-needed`, `unresolved`, preview-only, declined,
 * or interrupted; `not-required` with `dryRun: false`; any non-
 * `not-required` confirmation with `dryRun: true`; a missing, duplicate, or
 * wrong-case settlement for an authorized commit-capable row; or an untyped
 * settlement result. The explicit `dryRun` argument distinguishes preview-only
 * from the invalid non-dry-run no-settlement state; confirmation and
 * settlement count alone cannot do so. Confirmation interruption is ORed into
 * the settled batch interruption flag because `heal()` returned before the
 * terminal exchange began. Failed commits retain their rows and add matching
 * case-scoped errors without collapsing an integrity refusal into an
 * execution-environment failure: integrity failures remain
 * `INTEGRITY_VIOLATION`, while genuine persistence failures remain
 * `FS_IO_ERROR`. The error itself must carry `details.partiallyWritten` from
 * its `HealCommitOutcome`, because report mapping reads the error details
 * rather than the settlement wrapper. Other structured details from the
 * underlying classified error remain available, while the outcome's
 * partial-write evidence authoritatively replaces any stale value carried by
 * that error.
 */
function settleHealOutcome(
  outcome: HealOutcome,
  confirmation: HealConfirmationOutcome,
  dryRun: boolean,
  commitCaseIds: ReadonlySet<string>,
  settlements: readonly HealCommitSettlement[],
): SettledHealOutcome {
  function unexpected(reason: string): never {
    throw new UnexpectedCrashError(`Healing settlement invariant failed: ${reason}`);
  }
  const settlementsByCaseId = new Map<string, HealCommitSettlement>();
  for (const settlement of settlements) {
    if (settlementsByCaseId.has(settlement.caseId)) {
      unexpected(`duplicate settlement for ${settlement.caseId}`);
    }
    settlementsByCaseId.set(settlement.caseId, settlement);
  }

  const resultIds = new Set(outcome.results.map(({ id }) => id));
  const commitCapableIds = new Set(outcome.results
    .filter(({ repairOutcome }) => repairOutcome === 'healed' || repairOutcome === 'partially-healed')
    .map(({ id }) => id));
  if (commitCaseIds.size !== commitCapableIds.size || [...commitCaseIds].some((caseId) => !commitCapableIds.has(caseId))) {
    unexpected('commit capabilities do not match commit-capable measured cases');
  }
  for (const [caseId, settlement] of settlementsByCaseId) {
    if (!resultIds.has(caseId) || settlement.commit.file !== caseId) {
      unexpected(`settlement does not match a measured case: ${caseId}`);
    }
  }

  if (dryRun && confirmation !== 'not-required') {
    unexpected('a dry run received a promptable confirmation outcome');
  }

  const commitErrors: Array<HealOutcome['errors'][number]> = [];
  const results = outcome.results.map((result) => {
    const settlement = settlementsByCaseId.get(result.id);
    switch (result.repairOutcome) {
      case 'no-changes-needed':
        if (settlement !== undefined) {
          unexpected(`${result.repairOutcome} case has a commit settlement: ${result.id}`);
        }
        return { ...result, application: 'no-artifact-change' as const, stopReason: 'settled' as const };
      case 'unresolved':
        if (settlement !== undefined) {
          unexpected(`${result.repairOutcome} case has a commit settlement: ${result.id}`);
        }
        return result.stopReason === 'deadline'
          ? { ...result, application: 'not-eligible' as const }
          : { ...result, application: 'no-artifact-change' as const };
      case 'healed':
      case 'partially-healed':
        switch (confirmation) {
          case 'not-required':
            if (!dryRun || settlement !== undefined) {
              unexpected(`non-preview ${result.repairOutcome} case lacks an authorized settlement: ${result.id}`);
            }
            return { ...result, application: 'preview-only' as const };
          case 'declined':
            if (settlement !== undefined) {
              unexpected(`declined ${result.repairOutcome} case has a commit settlement: ${result.id}`);
            }
            return { ...result, application: 'declined' as const };
          case 'interrupted':
            if (settlement !== undefined) {
              unexpected(`interrupted ${result.repairOutcome} case has a commit settlement: ${result.id}`);
            }
            return { ...result, application: 'not-applied-interrupted' as const };
          case 'authorized':
            if (dryRun) {
              unexpected(`authorized ${result.repairOutcome} case occurred during a dry run: ${result.id}`);
            }
            if (settlement === undefined) {
              unexpected(`authorized ${result.repairOutcome} case lacks a commit settlement: ${result.id}`);
            }
            if (settlement.result.outcome === 'committed') {
              return { ...result, application: 'applied' as const };
            }
            if (settlement.result.outcome === 'failed') {
              const partiallyWritten = settlement.result.partiallyWritten;
              if (!(settlement.result.error instanceof FsIoError
                || settlement.result.error instanceof IntegrityViolationError)
                || !Array.isArray(partiallyWritten)
                || !partiallyWritten.every((artifact) => artifact === 'plan' || artifact === 'grounding')) {
                return unexpected(`malformed failed settlement for ${result.id}`);
              }
              const persisted = partiallyWritten.length === 0 ? 'no artifacts' : partiallyWritten.join(' and ');
              const errorDetails = {
                ...(settlement.result.error.details ?? {}),
                partiallyWritten: [...partiallyWritten],
              };
              commitErrors.push({
                file: result.file,
                error: settlement.result.error instanceof IntegrityViolationError
                  ? new IntegrityViolationError(
                    `Healing artifacts could not be committed after persisting ${persisted}.`,
                    errorDetails,
                    { cause: settlement.result.error },
                  )
                  : new FsIoError(
                    `Healing artifacts could not be committed after persisting ${persisted}.`,
                    errorDetails,
                    { cause: settlement.result.error },
                  ),
              });
              return {
                ...result,
                application: partiallyWritten.length === 0 ? 'apply-failed' as const : 'partially-applied' as const,
              };
            }
            return unexpected(`unknown settlement outcome: ${String((settlement.result as { readonly outcome: unknown }).outcome)}`);
          default:
            return unexpected(`unknown confirmation outcome: ${String(confirmation)}`);
        }
      default:
        return unexpected(`unknown repair outcome: ${String(result.repairOutcome)}`);
    }
  });

  return {
    ...outcome,
    results,
    errors: [...outcome.errors, ...commitErrors],
    interrupted: outcome.interrupted || confirmation === 'interrupted',
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
 * An empty `result.commits` map has no artifact write to authorize, so it
 * skips confirmation in every execution environment.
 *
 * A dry run never prompts and never invokes `commit()`, irrespective of
 * `--yes` or `-y`: it reports pending eligible repairs as preview-only while
 * leaving their buffered artifact changes unapplied. The two flag forms are
 * the same pre-authorization. Without either form, a non-interactive
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
 * After authorized capabilities settle, this boundary first reconciles
 * failed commits, builds one candidate, and passes it through the shared
 * finalizer. Building after settlement prevents an initial report from
 * becoming stale and keeps a failed commit case-scoped; finalization then
 * rounds executed heal-case durations, normalizes the public identities, and
 * recomputes summary from the settled facts. The emergency singleton from
 * that shared boundary alone selects exit code 3, so every other semantic
 * exit code remains the report builder's decision.
 */
export async function runHealCommand(
  input: HealCommandInput,
): Promise<HealCommandOutput> {
  let projectRoot = input.cwd;
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
    projectRoot = config.projectRoot;
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
      containWrites: createRunsDirContainedStorage(ambercast.storage),
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
    if (!input.list) {
      const target = resolveTarget({
        targets: config.targets,
        defaultTarget: config.defaultTarget,
        explicitTarget: input.target,
      });
      if (target instanceof AmbercastError) throw target;
      if (config.targets[target.name]!.healReplayIsolation !== 'idempotent') {
        throw new ConfigInvalidError('Healing requires the selected target to set healReplayIsolation to idempotent.');
      }
    }

    const result: HealBatchResult = await heal(deps, options);
    const confirmation = await promptForHealConfirmation(result.commits, input, {
      isCI,
      isInteractive: () => createTtyInteractivityCheck()(),
      readConfirmationAnswer: (commits, signal) => createConfirmationAnswerReader()(commits, signal),
    });
    const settlements: HealCommitSettlement[] = [];
    if (!input.dryRun && confirmation === 'authorized') {
      for (const [caseId, commit] of result.commits) {
        try {
          settlements.push({ caseId, commit, result: await commit.commit() });
        } catch (error) {
          const partiallyWritten: ('plan' | 'grounding')[] = [];
          const persisted = partiallyWritten.length === 0 ? 'no artifacts' : partiallyWritten.join(' and ');
          settlements.push({
            caseId,
            commit,
            result: {
              outcome: 'failed',
              error: new FsIoError(
                `Healing artifacts could not be committed after persisting ${persisted}.`,
                {
                  ...(error instanceof FsIoError ? error.details ?? {} : {}),
                  partiallyWritten: [...partiallyWritten],
                },
                { cause: error },
              ),
              partiallyWritten,
            },
          });
        }
      }
    }

    const output = buildHealReport({
      ...reportContext(),
      outcome: settleHealOutcome(result.outcome, confirmation, input.dryRun, new Set(result.commits.keys()), settlements),
    });
    const finalized = finalizeReportEnvelope(output.envelope, projectRoot);
    return { exitCode: isEmergencyFinalizedEnvelope(finalized) ? 3 : output.exitCode, envelope: finalized };
  } catch (error) {
    const classified = error instanceof AmbercastError
      ? error
      : new UnexpectedCrashError('The heal command crashed unexpectedly.', undefined, { cause: error });
    const output = buildHealReport({ ...reportContext(), error: classified });
    const finalized = finalizeReportEnvelope(output.envelope, projectRoot);
    return { exitCode: isEmergencyFinalizedEnvelope(finalized) ? 3 : output.exitCode, envelope: finalized };
  }
}
