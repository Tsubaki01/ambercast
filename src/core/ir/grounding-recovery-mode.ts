/**
 * Defines the recovery treatment selected solely from a committed plan step.
 *
 * This belongs to the IR layer because neither the classification nor its
 * exhaustiveness proof needs storage, browser, or provider capabilities. It
 * keeps the policy next to other artifact-only facts such as grounding
 * coverage claims, rather than letting replay and healing own competing
 * copies.
 */

import type { ActionStep, AssertStep, Step } from './schema.js';

/** The Stage 1 recovery treatment available for one plan-step variant. */
export type GroundingRecoveryMode = 'element-reground' | 'ai-retrace' | 'none';

/**
 * Classifies every action variant for grounding recovery.
 *
 * A `Record` over the complete action literal union makes a newly added action
 * fail at this declaration until it receives a recovery treatment. A switch
 * over `Step['kind']` can prove only the outer action/assert/capture/AI split;
 * it cannot make that nested decision exhaustive. Replay consumes this exact
 * constant at its dispatch boundary so it does not reconstruct a second table
 * that merely happens to agree with healing.
 */
export const ACTION_GROUNDING_MODE: Record<ActionStep['action'], GroundingRecoveryMode> = {
  click: 'element-reground',
  press: 'element-reground',
  fill: 'element-reground',
  'fill-secret': 'element-reground',
  navigate: 'none',
};

/**
 * Classifies every assertion variant for grounding recovery.
 *
 * This is separate from the action table because assertion discriminants have
 * their own literal union. The typed key space makes the compiler identify an
 * unclassified future check where the table is authored, before a dispatcher
 * can silently choose a different treatment.
 */
export const ASSERT_GROUNDING_MODE: Record<AssertStep['check'], GroundingRecoveryMode> = {
  'element-visible': 'element-reground',
  'text-equals': 'element-reground',
  'text-visible': 'none',
  'url-matches': 'none',
  'element-count': 'none',
};

/**
 * Returns the shared Stage 1 recovery treatment for a schema-valid plan step.
 *
 * @param step - A committed plan step whose discriminants select its treatment.
 * @returns The recovery mode that replay and healing must share.
 *
 * @remarks
 * The outer switch deliberately delegates nested action and assertion choices
 * to the exported typed tables. Keeping those tables as the sole nested
 * authority lets consumers use the same entries directly where their dispatch
 * needs to decide whether element grounding is consumed.
 */
export function groundingRecoveryModeForStep(step: Step): GroundingRecoveryMode {
  switch (step.kind) {
    case 'action':
      return ACTION_GROUNDING_MODE[step.action];
    case 'assert':
      return ASSERT_GROUNDING_MODE[step.check];
    case 'capture':
      return 'element-reground';
    case 'ai':
      return 'ai-retrace';
  }
}
