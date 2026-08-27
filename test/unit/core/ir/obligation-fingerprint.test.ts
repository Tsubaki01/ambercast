import { describe, expect, it } from 'vitest';
import { computeObligationFingerprint, obligationFingerprintMatches } from '#core/ir/obligation-fingerprint.js';
import { Step } from '#core/ir/schema.js';

const SPAN = { startLine: 2, endLine: 2 };
const NEXT_SPAN = { startLine: 3, endLine: 3 };
const COVERAGE_SPAN = { startLine: 2, startColumn: 1, endLine: 2, endColumn: 24 };
const NEXT_COVERAGE_SPAN = { startLine: 3, startColumn: 1, endLine: 3, endColumn: 24 };
const BUTTON = { strategy: 'accessibility' as const, role: 'button', name: 'Continue' };

function ai(overrides: Record<string, unknown> = {}) {
  return Step.parse({
    id: 'agent-step', kind: 'ai', instruction: 'Open {{run.order.id}} then {{run.order.id}}',
    secrets: [{ ref: '{{secrets.auth.token}}', sourceSpan: SPAN }],
    instructionCoverage: [{ id: 'criterion-a', kind: 'action', sourceSpan: COVERAGE_SPAN }, { id: 'criterion-b', kind: 'success', sourceSpan: NEXT_COVERAGE_SPAN }],
    ...overrides,
  });
}

describe('obligation fingerprints', () => {
  it('matches an unchanged obligation even when ordinary executable detail changes', () => {
    const before = Step.parse({ id: 'navigate', kind: 'action', action: 'navigate', url: 'https://example.test/{{run.order.id}}' });
    const after = Step.parse({ id: 'navigate', kind: 'action', action: 'navigate', url: 'https://other.example.test/{{run.order.id}}' });

    expect(obligationFingerprintMatches(before, after)).toBe(true);
  });

  it.each([
    ['an action opcode', Step.parse({ id: 'step', kind: 'action', action: 'click', target: BUTTON }), Step.parse({ id: 'step', kind: 'action', action: 'press', target: BUTTON, key: 'Enter' })],
    ['an assert opcode', Step.parse({ id: 'assertion', kind: 'assert', check: 'text-visible', text: 'Continue' }), Step.parse({ id: 'assertion', kind: 'assert', check: 'text-equals', target: BUTTON, text: 'Continue' })],
    ['an AI secret reference', ai(), ai({ secrets: [{ ref: '{{secrets.auth.other}}', sourceSpan: SPAN }] })],
    ['an AI secret source span', ai(), ai({ secrets: [{ ref: '{{secrets.auth.token}}', sourceSpan: NEXT_SPAN }] })],
    ['a fill-secret reference', Step.parse({ id: 'secret', kind: 'action', action: 'fill-secret', target: BUTTON, secretRef: '{{secrets.auth.token}}', secretGrantSpan: SPAN }), Step.parse({ id: 'secret', kind: 'action', action: 'fill-secret', target: BUTTON, secretRef: '{{secrets.auth.other}}', secretGrantSpan: SPAN })],
    ['a fill-secret source span', Step.parse({ id: 'secret', kind: 'action', action: 'fill-secret', target: BUTTON, secretRef: '{{secrets.auth.token}}', secretGrantSpan: SPAN }), Step.parse({ id: 'secret', kind: 'action', action: 'fill-secret', target: BUTTON, secretRef: '{{secrets.auth.token}}', secretGrantSpan: NEXT_SPAN })],
    ['an instruction coverage id', ai(), ai({ instructionCoverage: [{ id: 'criterion-z', kind: 'action', sourceSpan: COVERAGE_SPAN }, { id: 'criterion-b', kind: 'success', sourceSpan: NEXT_COVERAGE_SPAN }] })],
    ['an instruction coverage kind', ai(), ai({ instructionCoverage: [{ id: 'criterion-a', kind: 'success', sourceSpan: COVERAGE_SPAN }, { id: 'criterion-b', kind: 'success', sourceSpan: NEXT_COVERAGE_SPAN }] })],
    ['an instruction coverage span', ai(), ai({ instructionCoverage: [{ id: 'criterion-a', kind: 'action', sourceSpan: NEXT_COVERAGE_SPAN }, { id: 'criterion-b', kind: 'success', sourceSpan: NEXT_COVERAGE_SPAN }] })],
    ['instruction coverage ordering', ai(), ai({ instructionCoverage: [{ id: 'criterion-b', kind: 'success', sourceSpan: NEXT_COVERAGE_SPAN }, { id: 'criterion-a', kind: 'action', sourceSpan: COVERAGE_SPAN }] })],
    ['a capture variable', Step.parse({ id: 'capture', kind: 'capture', target: BUTTON, variable: 'orderId' }), Step.parse({ id: 'capture', kind: 'capture', target: BUTTON, variable: 'otherId' })],
    ['a removed run reference', ai(), ai({ instruction: 'Open {{run.order.id}}' })],
    ['an added run reference', ai({ instruction: 'Open {{run.order.id}}' }), ai()],
    ['run reference ordering', ai({ instruction: 'Open {{run.order.id}} then {{run.user.id}}' }), ai({ instruction: 'Open {{run.user.id}} then {{run.order.id}}' })],
    ['a malformed run-reference spelling', ai({ instruction: 'Open {{run.order-id}}' }), ai({ instruction: 'Open {{run.order_id}}' })],
  ])('does not match when %s changes', (_dimension, before, after) => {
    expect(obligationFingerprintMatches(before, after)).toBe(false);
  });

  it('rejects replacement identity changes before comparing fingerprints', () => {
    const step = Step.parse({ id: 'capture', kind: 'capture', target: BUTTON, variable: 'orderId' });
    const renamed = Step.parse({ id: 'renamed', kind: 'capture', target: BUTTON, variable: 'orderId' });
    const retyped = Step.parse({ id: 'capture', kind: 'action', action: 'click', target: BUTTON });

    expect(obligationFingerprintMatches(step, renamed)).toBe(false);
    expect(obligationFingerprintMatches(step, retyped)).toBe(false);
  });

  it('uses a stable non-empty SHA-256 fingerprint for a valid step', () => {
    expect(computeObligationFingerprint(ai())).toMatch(/^[a-f0-9]{64}$/);
  });

  it('treats an omitted AI secrets field and an explicit empty secrets array as the same fixed-shape obligation', () => {
    const omitted = Step.parse({
      id: 'agent-step', kind: 'ai', instruction: 'Open {{run.order.id}} then {{run.order.id}}',
      instructionCoverage: [{ id: 'criterion-a', kind: 'action', sourceSpan: COVERAGE_SPAN }],
    });
    const explicitEmpty = Step.parse({
      id: 'agent-step', kind: 'ai', instruction: 'Open {{run.order.id}} then {{run.order.id}}',
      secrets: [], instructionCoverage: [{ id: 'criterion-a', kind: 'action', sourceSpan: COVERAGE_SPAN }],
    });

    expect(computeObligationFingerprint(omitted)).toBe(computeObligationFingerprint(explicitEmpty));
    expect(obligationFingerprintMatches(omitted, explicitEmpty)).toBe(true);
  });
});
