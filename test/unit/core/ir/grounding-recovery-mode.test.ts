import { describe, expect, it } from 'vitest';
import {
  ACTION_GROUNDING_MODE,
  ASSERT_GROUNDING_MODE,
  groundingRecoveryModeForStep,
} from '#core/ir/grounding-recovery-mode.js';
import { ActionStep, AiStep, AssertStep, CaptureStep, Step } from '#core/ir/schema.js';

const TARGET = { strategy: 'accessibility' as const, role: 'button', name: 'Submit' };

function actionFixture(action: keyof typeof ACTION_GROUNDING_MODE) {
  return action === 'click' ? { id: 'click', kind: 'action', action, target: TARGET }
    : action === 'navigate' ? { id: 'navigate', kind: 'action', action, url: '/dashboard' }
      : action === 'press' ? { id: 'press', kind: 'action', action, target: TARGET, key: 'Enter' }
        : action === 'fill' ? { id: 'fill', kind: 'action', action, target: TARGET, value: 'value' }
          : { id: 'fill-secret', kind: 'action', action, target: TARGET, secretRef: '{{secrets.PASSWORD}}', secretGrantSpan: { startLine: 1, endLine: 1 } };
}

function assertFixture(check: keyof typeof ASSERT_GROUNDING_MODE) {
  return check === 'text-visible' ? { id: 'text-visible', kind: 'assert', check, text: 'Dashboard' }
    : check === 'element-visible' ? { id: 'element-visible', kind: 'assert', check, target: TARGET }
      : check === 'text-equals' ? { id: 'text-equals', kind: 'assert', check, target: TARGET, text: 'Dashboard' }
        : check === 'url-matches' ? { id: 'url-matches', kind: 'assert', check, pattern: '/dashboard' }
          : { id: 'element-count', kind: 'assert', check, target: TARGET, count: 1 };
}

describe('groundingRecoveryModeForStep', () => {
  it('classifies every schema action/check discriminant plus capture and AI', () => {
    const cases = [
      ...ActionStep.options.map((variant) => {
        const action = variant.shape.action.value as keyof typeof ACTION_GROUNDING_MODE;
        const expected = {
          click: 'element-reground',
          press: 'element-reground',
          fill: 'element-reground',
          'fill-secret': 'element-reground',
          navigate: 'none',
        } as const;
        return [Step.parse(actionFixture(action)), expected[action]] as const;
      }),
      ...AssertStep.options.map((variant) => {
        const check = variant.shape.check.value as keyof typeof ASSERT_GROUNDING_MODE;
        const expected = {
          'element-visible': 'element-reground',
          'text-equals': 'element-reground',
          'text-visible': 'none',
          'url-matches': 'none',
          'element-count': 'none',
        } as const;
        return [Step.parse(assertFixture(check)), expected[check]] as const;
      }),
      [CaptureStep.parse({ id: 'capture', kind: 'capture', target: TARGET, variable: 'result' }), 'element-reground'] as const,
      [AiStep.parse({ id: 'ai', kind: 'ai', instruction: 'Verify the dashboard.', instructionCoverage: [{ id: 'dashboard', kind: 'success', sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 22 } }] }), 'ai-retrace'] as const,
    ];

    expect(cases).toHaveLength(12);
    for (const [step, mode] of cases) expect(groundingRecoveryModeForStep(step)).toBe(mode);
  });

  it('partitions the complete schema Step union without a missing table key', () => {
    const schemaActions = ActionStep.options.map((variant) => variant.shape.action.value).sort();
    const schemaChecks = AssertStep.options.map((variant) => variant.shape.check.value).sort();

    expect(Object.keys(ACTION_GROUNDING_MODE).sort()).toEqual(schemaActions);
    expect(Object.keys(ASSERT_GROUNDING_MODE).sort()).toEqual(schemaChecks);
    expect([...Object.values(ACTION_GROUNDING_MODE), ...Object.values(ASSERT_GROUNDING_MODE), 'element-reground', 'ai-retrace'].sort())
      .toEqual(['ai-retrace', 'element-reground', 'element-reground', 'element-reground', 'element-reground', 'element-reground', 'element-reground', 'element-reground', 'none', 'none', 'none', 'none'].sort());
  });
});
