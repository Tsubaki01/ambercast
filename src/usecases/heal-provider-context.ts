import type { NormalizedTestMd } from '#core/ir/normalize.js';
import type { JsonValueT, Step, TargetDefinition } from '#core/ir/schema.js';
import type { StepResult } from '#report/schema.js';
import type { RunCaseOutcome, readTrustedInstructionCoveredPlan } from './run.js';

/** A validated plan whose prompt coverage has already been checked for healing. */
export type TrustedPlan = Awaited<ReturnType<typeof readTrustedInstructionCoveredPlan>>['plan'];

/**
 * The replay evidence available to the repair state machine.
 *
 * An interrupted replay intentionally has no partial evidence. A completed
 * replay retains the first-failure frontier and attempt identity so callers
 * can relate provider context to the replay that produced it.
 */
export type ReplayMeasurement =
  | { readonly interrupted: true }
  | {
    readonly interrupted: false;
    readonly replay: RunCaseOutcome;
    readonly firstFailureIndex: number;
    readonly attemptOrdinal: number;
    readonly evidenceDir: string;
  };

/**
 * One adopted frontier replacement retained as provider context for later repairs.
 *
 * Only improvements enter this closed record: rejected or discarded candidates
 * must not influence a later request. The paired indices prove strict frontier
 * progress, and the nullable category preserves the meaningful absence of a
 * step classification when replay produced no step evidence.
 */
export interface RepairHistoryEntry {
  readonly stepId: string;
  readonly before: Step;
  readonly after: Step;
  readonly fromFirstFailureIndex: number;
  readonly toFirstFailureIndex: number;
  readonly failureCategory: StepResult['type'] | null;
}

/**
 * The only replay fields permitted to reach a repair provider.
 *
 * Provider repair needs stable step identity, classification, and outcome to
 * locate the frontier without acquiring screenshots, observed page content,
 * artifact locations, or other browser-derived evidence.
 */
export type ProviderReplayStep = Pick<StepResult, 'id' | 'type' | 'status'>;

/**
 * Projects replay results into the minimal evidence allowed in provider context.
 *
 * The projection retains only step identity and execution status (`passed`,
 * `failed`, `error`, or `skipped`). It excludes
 * screenshots and every page-evidence field, because provider context must not
 * acquire filesystem locations or browser evidence merely as repair history
 * grows across iterations.
 *
 * @param steps - Replay step results to project into provider-safe evidence.
 * @returns Provider-safe replay evidence containing only identity,
 * classification, and execution status.
 */
export function toProviderReplayEvidence(steps: readonly StepResult[]): readonly ProviderReplayStep[] {
  return steps.map(({ id, type, status }) => ({ id, type, status }));
}

/**
 * The data-only shape supplied to a Stage 2 repair provider.
 *
 * Locally derived inputs and browser-derived replay evidence remain separate
 * so provenance is visible without treating page-derived text as trusted plan
 * data. `trustedInputs` is only a provenance label: neither it nor any nested
 * string gains instruction authority, and the prompt envelope's existing
 * "never instructions" framing governs the complete context.
 */
export interface Stage2RepairContext {
  readonly trustedInputs: {
    readonly testMd: NormalizedTestMd;
    readonly targets: Readonly<Record<string, TargetDefinition>>;
    readonly currentPlan: {
      readonly schemaVersion: number;
      readonly source: { readonly inputsDigest: string };
      readonly targets: Readonly<Record<string, TargetDefinition>>;
      readonly steps: readonly Step[];
    };
    readonly frontier: { readonly index: number; readonly stepId: string };
    readonly repairHistory: readonly RepairHistoryEntry[];
  };
  readonly untrustedReplayEvidence: {
    readonly baselineFailure: {
      readonly explanation: string;
      readonly failingStep?: Step;
      readonly steps: readonly ProviderReplayStep[];
    };
    readonly currentFailure: {
      readonly explanation: string;
      readonly failingStep?: Step;
      readonly steps: readonly ProviderReplayStep[];
    };
  };
}

/**
 * Inputs paired by plan and replay measurement so a caller cannot combine
 * evidence with a different plan while building Stage 2 provider context.
 */
export interface Stage2RepairContextInputs {
  readonly normalizedTestMd: NormalizedTestMd;
  readonly baseline: {
    /** The case-start plan; future repair stages must never mutate it in place. */
    readonly plan: TrustedPlan;
    readonly measurement: ReplayMeasurement & { readonly interrupted: false };
  };
  readonly current: {
    readonly plan: TrustedPlan;
    readonly measurement: ReplayMeasurement & { readonly interrupted: false };
  };
  readonly repairHistory: readonly RepairHistoryEntry[];
}

/**
 * Builds the JSON-safe, data-only context for one Stage 2 provider request.
 *
 * The builder derives duplicated fields only from the paired current plan
 * and replay measurement, preserving a single attribution source for the
 * frontier. It retains case-start failure evidence from `baseline` while
 * attributing current failure evidence and the current plan to `current`.
 * A failure index outside a plan's step range omits `failingStep` entirely,
 * rather than serialize it as `null`.
 *
 * The builder is the JsonValueT compatibility boundary: callers receive a
 * JSON-safe value and must not add an unchecked cast. Its provenance split is
 * not an authority split; all values remain data under the prompt envelope's
 * existing instruction-resistant framing.
 *
 * @remarks
 * `currentPlan` is constructed by explicitly enumerating `schemaVersion`,
 * `source`, `targets`, and `steps`; it must not spread the plan object. This
 * structurally excludes `generatorMeta`, including if the plan schema gains
 * additional fields later. The builder also snapshots `repairHistory` before
 * placing it in the context, so later caller mutations such as `.push()`
 * cannot retroactively alter an already-built context.
 *
 * @param params - The normalized prompt, paired baseline and current replay
 * measurements, and adopted repair history for this repair request.
 * @returns The JSON-safe, provenance-separated context for a Stage 2 provider
 * request.
 *
 * @example
 * ```ts
 * const context = buildStage2RepairContext({
 *   normalizedTestMd,
 *   baseline,
 *   current,
 *   repairHistory,
 * });
 * ```
 */
export function buildStage2RepairContext(params: Stage2RepairContextInputs): JsonValueT {
  const currentPlan = {
    schemaVersion: params.current.plan.schemaVersion,
    source: params.current.plan.source,
    targets: params.current.plan.targets,
    steps: params.current.plan.steps,
  };
  const frontierIndex = params.current.measurement.firstFailureIndex;
  const replayEvidence = (
    plan: TrustedPlan,
    measurement: ReplayMeasurement & { readonly interrupted: false },
  ) => {
    const failingStep = plan.steps[measurement.firstFailureIndex];
    return {
      explanation: measurement.replay.result.explanation,
      ...(failingStep === undefined ? {} : { failingStep }),
      steps: toProviderReplayEvidence(measurement.replay.result.steps),
    };
  };
  const context: Stage2RepairContext = {
    trustedInputs: {
      testMd: params.normalizedTestMd,
      targets: params.current.plan.targets,
      currentPlan,
      frontier: { index: frontierIndex, stepId: params.current.plan.steps[frontierIndex]?.id ?? '' },
      repairHistory: [...params.repairHistory],
    },
    untrustedReplayEvidence: {
      baselineFailure: replayEvidence(params.baseline.plan, params.baseline.measurement),
      currentFailure: replayEvidence(params.current.plan, params.current.measurement),
    },
  };

  return context as unknown as JsonValueT;
}
