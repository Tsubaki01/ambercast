import { describe, expect, it } from 'vitest';
import { extractStepRunRefs, matchRunReferenceTokens } from '#core/ir/run-ref.js';
import { Step } from '#core/ir/schema.js';

const BUTTON = { strategy: 'accessibility' as const, role: 'textbox', name: 'Input' };

describe('matchRunReferenceTokens', () => {
  it('preserves valid and malformed tokens in source order', () => {
    expect(matchRunReferenceTokens('a {{run.order.id}} b {{run.order-id}} c {{run.user_name.value}}')).toEqual([
      { raw: '{{run.order.id}}', name: 'order.id', malformed: false },
      { raw: '{{run.order-id}}', name: undefined, malformed: true },
      { raw: '{{run.user_name.value}}', name: 'user_name.value', malformed: false },
    ]);
  });

  it('does not manufacture a token from ordinary braces', () => {
    expect(matchRunReferenceTokens('literal {run.x} {{run}}')).toEqual([]);
  });

  it.each(['{{run.-bad}}', '{{run. bad}}', '{{run.'])('retains malformed prefix %j', (value) => {
    expect(matchRunReferenceTokens(value)).toEqual([{ raw: value, name: undefined, malformed: true }]);
  });
});

describe('extractStepRunRefs', () => {
  it('enumerates every text-bearing step field, preserving field order and duplicates', () => {
    const steps = [
      Step.parse({ id: 'navigate', kind: 'action', action: 'navigate', url: 'https://example.test/{{run.order.id}}/{{run.order.id}}' }),
      Step.parse({ id: 'fill', kind: 'action', action: 'fill', target: BUTTON, value: '{{run.form.value}}' }),
      Step.parse({ id: 'visible', kind: 'assert', check: 'text-visible', text: '{{run.message}}' }),
      Step.parse({ id: 'equals', kind: 'assert', check: 'text-equals', target: BUTTON, text: '{{run.expected}}' }),
      Step.parse({ id: 'url', kind: 'assert', check: 'url-matches', pattern: '/{{run.path}}/' }),
      Step.parse({ id: 'ai', kind: 'ai', instruction: '{{run.first}} then {{run.second}}', instructionCoverage: [{ id: 'a', kind: 'action', sourceSpan: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 } }] }),
    ];

    expect(steps.map(extractStepRunRefs)).toEqual([
      ['{{run.order.id}}', '{{run.order.id}}'], ['{{run.form.value}}'], ['{{run.message}}'], ['{{run.expected}}'], ['{{run.path}}'], ['{{run.first}}', '{{run.second}}'],
    ]);
  });

  it('retains malformed references as raw obligations instead of dropping them', () => {
    const step = Step.parse({ id: 'fill', kind: 'action', action: 'fill', target: BUTTON, value: '{{run.bad-name}} and {{run.good_name}}' });

    expect(extractStepRunRefs(step)).toEqual(['{{run.bad-name}}', '{{run.good_name}}']);
  });
});
