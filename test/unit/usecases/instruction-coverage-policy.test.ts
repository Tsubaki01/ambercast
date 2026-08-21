import { describe, expect, it } from 'vitest';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import { TraceRecord } from '#core/ir/schema.js';
import type {
  InstructionCriterion,
  JsonValueT,
  TraceAssert,
  TraceRecordWithCoverageStorage,
} from '#core/ir/schema.js';
import type { PreScannedTraceRecord } from '#ports/ai.js';
import {
  classifyPreScannedTraceCoverage,
  materializeAssertionForCoverage,
  validateCommittedInstructionCoverage,
  validateGeneratedInstructionCoverage,
} from '#usecases/instruction-coverage-policy.js';
import type {
  GeneratedInstructionCoverage,
  InstructionCoverageIssue,
  InstructionCoverageResult,
  TrustedInstructionCriterion,
} from '#usecases/instruction-coverage-policy.js';

const TARGET = { strategy: 'accessibility' as const, role: 'status', name: 'Ready' };
const READY_ASSERTION = { type: 'assert' as const, check: 'text-visible' as const, text: 'Ready' };

function generatedCoverage(
  citation: string,
  id = 'ready',
  assertion: TraceAssert = READY_ASSERTION,
): GeneratedInstructionCoverage {
  return {
    instructionCoverage: [{ id, kind: 'success', citation }],
    verificationIntent: [{ criterionId: id, assertion }],
  };
}

function expectSuccess<T>(result: InstructionCoverageResult<T>): T {
  expect(result.success).toBe(true);
  if (!result.success) {
    throw new Error(`Expected policy success, received ${JSON.stringify(result.issues)}`);
  }
  return result.data;
}

function expectIssueCodes<T>(
  result: InstructionCoverageResult<T>,
  codes: readonly InstructionCoverageIssue['code'][],
): readonly InstructionCoverageIssue[] {
  expect(result.success).toBe(false);
  if (result.success) {
    throw new Error('Expected policy issues.');
  }
  expect(result.issues.map(({ code }) => code)).toEqual(codes);
  return result.issues;
}

function committed(
  id: string,
  startLine: number,
  startColumn: number,
  endLine: number,
  endColumn: number,
  kind: 'success' | 'action' = 'success',
): InstructionCriterion {
  return { id, kind, sourceSpan: { startLine, startColumn, endLine, endColumn } };
}

function trusted(
  id: string,
  text: string,
  kind: 'success' | 'action' = 'success',
): TrustedInstructionCriterion {
  return {
    ...committed(id, 1, 1, 1, text.length + 1, kind),
    text,
  };
}

function preScanned(trace: TraceRecordWithCoverageStorage): PreScannedTraceRecord {
  return trace as PreScannedTraceRecord;
}

describe('validateGeneratedInstructionCoverage citation attribution', () => {
  it.each([
    ['LF first line', 'Alpha\nBeta', 'Alpha', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }],
    ['LF second line at EOF', 'Alpha\nBeta', 'Beta', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }],
    ['citation containing LF', 'Alpha\nBeta', 'Alpha\n', { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }],
    ['CRLF normalization', 'Alpha\r\nBeta', 'Beta', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }],
    ['lone CR normalization', 'Alpha\rBeta', 'Beta', { startLine: 2, startColumn: 1, endLine: 2, endColumn: 5 }],
    ['one leading BOM removal', '\uFEFFAlpha', 'Alpha', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }],
    ['terminal LF boundary', 'Alpha\n', 'Alpha\n', { startLine: 1, startColumn: 1, endLine: 2, endColumn: 1 }],
    ['no terminal LF EOF', 'Alpha', 'Alpha', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 6 }],
    ['emoji UTF-16 width', '😀 Ready', '😀', { startLine: 1, startColumn: 1, endLine: 1, endColumn: 3 }],
    ['same-line second clause', 'Act, then succeed', 'succeed', { startLine: 1, startColumn: 11, endLine: 1, endColumn: 18 }],
  ] as const)('derives precise coordinates for %s', (_name, raw, citation, sourceSpan) => {
    const result = expectSuccess(validateGeneratedInstructionCoverage(
      generatedCoverage(citation),
      normalizeTestMd(raw),
    ));

    expect(result).toEqual([{ id: 'ready', kind: 'success', sourceSpan }]);
    expect(result[0]).not.toHaveProperty('citation');
    expect(result[0]).not.toHaveProperty('verificationIntent');
  });

  it.each([
    ['missing', 'citation-not-found', 'Other', 'Alpha'],
    ['fabricated', 'citation-not-found', 'Alpha!', 'Alpha'],
    ['ambiguous', 'citation-not-unique', 'Alpha', 'Alpha and Alpha'],
    ['adjacent duplicate', 'citation-not-unique', 'Alpha', 'AlphaAlpha'],
    ['self-overlapping', 'citation-not-unique', 'aba', 'ababa'],
    ['empty', 'citation-whitespace-only', '', 'Alpha'],
    ['spaces', 'citation-whitespace-only', ' \t', 'Alpha'],
    ['newline only', 'citation-whitespace-only', '\n', 'Alpha'],
  ] as const)('rejects a %s citation with a stable code', (_name, code, citation, prompt) => {
    expectIssueCodes(
      validateGeneratedInstructionCoverage(generatedCoverage(citation), normalizeTestMd(prompt)),
      [code],
    );
  });

  it('rejects duplicate IDs and duplicate resolved ranges while accumulating deterministic issues', () => {
    const result = validateGeneratedInstructionCoverage({
      instructionCoverage: [
        { id: 'ready', kind: 'success', citation: 'Ready' },
        { id: 'ready', kind: 'action', citation: 'Click' },
        { id: 'also-ready', kind: 'success', citation: 'Ready' },
      ],
      verificationIntent: [
        { criterionId: 'ready', assertion: READY_ASSERTION },
        { criterionId: 'also-ready', assertion: READY_ASSERTION },
      ],
    }, normalizeTestMd('Click, then Ready'));

    const issues = expectIssueCodes(result, [
      'criterion-id-duplicate',
      'criterion-range-duplicate',
    ]);
    expect(issues.map(({ path }) => path)).toEqual([
      ['instructionCoverage', 1, 'id'],
      ['instructionCoverage', 2, 'citation'],
    ]);
  });

  it('sorts successful committed coverage by source range, kind, and ID', () => {
    const result = expectSuccess(validateGeneratedInstructionCoverage({
      instructionCoverage: [
        { id: 'success-second', kind: 'success', citation: 'Done' },
        { id: 'action-first', kind: 'action', citation: 'Click' },
      ],
      verificationIntent: [{ criterionId: 'success-second', assertion: READY_ASSERTION }],
    }, normalizeTestMd('Click, then Done')));

    expect(result.map(({ id }) => id)).toEqual(['action-first', 'success-second']);
  });

  it.each([
    ['lone high surrogate', '\uD83D'],
    ['lone low surrogate', '\uDE00'],
  ] as const)('rejects a %s citation that would split an emoji source span', (_name, citation) => {
    const issues = expectIssueCodes(
      validateGeneratedInstructionCoverage(generatedCoverage(citation), normalizeTestMd('😀 Ready')),
      ['source-span-invalid'],
    );

    expect(issues).toEqual([
      expect.objectContaining({ path: ['instructionCoverage', 0, 'citation'] }),
    ]);
  });
});

describe('validateGeneratedInstructionCoverage transient intent', () => {
  it('rejects nonempty action-only coverage even when its empty terminal intent is an exact set', () => {
    const issues = expectIssueCodes(validateGeneratedInstructionCoverage({
      instructionCoverage: [{ id: 'click', kind: 'action', citation: 'Click' }],
      verificationIntent: [],
    }, normalizeTestMd('Click')), ['success-criterion-missing']);

    expect(issues).toEqual([
      expect.objectContaining({ path: ['instructionCoverage'] }),
    ]);
  });

  it('accepts an own-key-safe exact success set and never returns transient intent', () => {
    const result = expectSuccess(validateGeneratedInstructionCoverage({
      instructionCoverage: [
        { id: 'constructor', kind: 'success', citation: 'Ready' },
        { id: 'to-string', kind: 'action', citation: 'Click' },
      ],
      verificationIntent: [{ criterionId: 'constructor', assertion: READY_ASSERTION }],
    }, normalizeTestMd('Click, then Ready')));

    expect(result.map(({ id }) => id)).toEqual(['to-string', 'constructor']);
    expect(JSON.stringify(result)).not.toContain('verificationIntent');
  });

  it.each([
    ['missing success', [], ['intent-id-missing']],
    ['unknown ID', [{ criterionId: 'unknown', assertion: READY_ASSERTION }], ['intent-id-missing', 'intent-id-unknown']],
    ['duplicate ID', [
      { criterionId: 'ready', assertion: READY_ASSERTION },
      { criterionId: 'ready', assertion: READY_ASSERTION },
    ], ['intent-id-duplicate']],
  ] as const)('rejects %s in the success-intent bijection', (_name, verificationIntent, codes) => {
    expectIssueCodes(validateGeneratedInstructionCoverage({
      ...generatedCoverage('Ready'),
      verificationIntent,
    }, normalizeTestMd('Ready')), codes);
  });

  it('rejects an action ID in terminal intent', () => {
    expectIssueCodes(validateGeneratedInstructionCoverage({
      instructionCoverage: [
        { id: 'click', kind: 'action', citation: 'Click' },
        { id: 'ready', kind: 'success', citation: 'Ready' },
      ],
      verificationIntent: [
        { criterionId: 'click', assertion: READY_ASSERTION },
        { criterionId: 'ready', assertion: READY_ASSERTION },
      ],
    }, normalizeTestMd('Click and Ready')), ['intent-id-action']);
  });

  it('rejects terminal url-matches without rejecting the supported assertion vocabulary', () => {
    expectIssueCodes(validateGeneratedInstructionCoverage(generatedCoverage('Ready', 'ready', {
      type: 'assert', check: 'url-matches', pattern: '/ready$',
    }), normalizeTestMd('Ready')), ['terminal-url-matches-forbidden']);
  });

  it('accepts exact element-count zero as a supported transient terminal intent', () => {
    const assertion = { type: 'assert' as const, check: 'element-count' as const, target: TARGET, count: 0 };
    expect(TraceRecord.safeParse({ events: [], verification: [assertion] }).success).toBe(true);
    expectSuccess(validateGeneratedInstructionCoverage(
      generatedCoverage('No alerts', 'no-alerts', assertion),
      normalizeTestMd('No alerts'),
    ));
  });

  it.each([
    ['text-visible', { type: 'assert', check: 'text-visible', text: 'Ready' }],
    ['text-equals', { type: 'assert', check: 'text-equals', target: TARGET, text: 'Ready' }],
    ['element-visible', { type: 'assert', check: 'element-visible', target: TARGET }],
    ['element-count', { type: 'assert', check: 'element-count', target: TARGET, count: 0 }],
  ] as const)('accepts the supported %s terminal intent vocabulary', (_name, assertion) => {
    expectSuccess(validateGeneratedInstructionCoverage(
      generatedCoverage('Ready', 'ready', assertion),
      normalizeTestMd('Ready'),
    ));
  });

  it('rejects the unbounded minimum-only zero terminal shape while the runtime schema rejects it', () => {
    const assertion = { type: 'assert', check: 'element-count', target: TARGET, min: 0 };
    expect(TraceRecord.safeParse({ events: [], verification: [assertion] }).success).toBe(false);
    expectIssueCodes(validateGeneratedInstructionCoverage(
      generatedCoverage('Ready', 'ready', assertion as unknown as TraceAssert),
      normalizeTestMd('Ready'),
    ), ['intent-assertion-unsupported']);
  });
});

describe('validateCommittedInstructionCoverage', () => {
  it.each([
    ['LF boundary', 'Alpha\nBeta', committed('ready', 1, 1, 2, 1), 'Alpha\n'],
    ['CRLF normalization', 'Alpha\r\nBeta', committed('ready', 2, 1, 2, 5), 'Beta'],
    ['lone CR normalization', 'Alpha\rBeta', committed('ready', 2, 1, 2, 5), 'Beta'],
    ['leading BOM removal', '\uFEFFAlpha', committed('ready', 1, 1, 1, 6), 'Alpha'],
    ['terminal LF EOF', 'Alpha\n', committed('ready', 1, 1, 2, 1), 'Alpha\n'],
    ['no trailing LF EOF', 'Alpha', committed('ready', 1, 1, 1, 6), 'Alpha'],
    ['emoji UTF-16 width', '😀 Ready', committed('ready', 1, 1, 1, 3), '😀'],
  ] as const)('re-extracts the numeric %s span', (_name, raw, criterion, text) => {
    expect(expectSuccess(
      validateCommittedInstructionCoverage([criterion], normalizeTestMd(raw)),
    )).toEqual([{ ...criterion, text }]);
  });

  it('re-extracts trusted text and keeps IDs step-local, including prototype-shaped IDs', () => {
    const first = expectSuccess(validateCommittedInstructionCoverage([
      committed('constructor', 1, 1, 1, 6),
      committed('to-string', 1, 7, 1, 12, 'action'),
    ], normalizeTestMd('Ready Click')));
    const second = expectSuccess(validateCommittedInstructionCoverage([
      committed('constructor', 1, 1, 1, 5),
    ], normalizeTestMd('Done')));

    expect(first.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 'constructor', text: 'Ready' },
      { id: 'to-string', text: 'Click' },
    ]);
    expect(second).toEqual([expect.objectContaining({ id: 'constructor', text: 'Done' })]);
  });

  it('rejects one step that assigns the same criterion ID to two distinct valid spans', () => {
    const issues = expectIssueCodes(validateCommittedInstructionCoverage([
      committed('ready', 1, 1, 1, 6),
      committed('ready', 1, 7, 1, 11),
    ], normalizeTestMd('Ready Done')), ['criterion-id-duplicate']);

    expect(issues.map(({ path }) => path)).toEqual([['instructionCoverage', 1, 'id']]);
  });

  it.each([
    ['zero start line', committed('ready', 0, 1, 1, 2)],
    ['zero start column', committed('ready', 1, 0, 1, 2)],
    ['reversed line', committed('ready', 2, 1, 1, 2)],
    ['reversed column', committed('ready', 1, 3, 1, 2)],
    ['zero width', committed('ready', 1, 2, 1, 2)],
    ['line out of range', committed('ready', 3, 1, 3, 2)],
    ['column out of range', committed('ready', 1, 1, 1, 99)],
    ['surrogate split start', committed('ready', 1, 2, 1, 3)],
    ['surrogate split end', committed('ready', 1, 1, 1, 2)],
  ] as const)('rejects %s coordinates', (_name, criterion) => {
    expectIssueCodes(
      validateCommittedInstructionCoverage([criterion], normalizeTestMd('😀 Ready')),
      ['source-span-invalid'],
    );
  });

  it('rejects whitespace-only re-extraction and duplicate committed ranges', () => {
    expectIssueCodes(validateCommittedInstructionCoverage([
      committed('space', 1, 2, 1, 3),
      committed('ready', 1, 3, 1, 8),
    ], normalizeTestMd('A Ready')), ['source-span-whitespace-only']);

    expectIssueCodes(validateCommittedInstructionCoverage([
      committed('ready', 1, 1, 1, 6),
      committed('also-ready', 1, 1, 1, 6),
    ], normalizeTestMd('Ready')), ['criterion-range-duplicate']);
  });

  it('rejects noncanonical committed ordering instead of silently sorting it', () => {
    expectIssueCodes(validateCommittedInstructionCoverage([
      committed('done', 1, 13, 1, 17),
      committed('click', 1, 1, 1, 6, 'action'),
    ], normalizeTestMd('Click, then Done')), ['criterion-order-invalid']);
  });

  it('requires at least one success criterion', () => {
    expectIssueCodes(validateCommittedInstructionCoverage([
      committed('click', 1, 1, 1, 6, 'action'),
    ], normalizeTestMd('Click')), ['success-criterion-missing']);
  });
});

describe('materializeAssertionForCoverage', () => {
  it('substitutes run text without mutating the assertion or run projection', () => {
    const assertion = {
      type: 'assert' as const,
      check: 'text-equals' as const,
      target: TARGET,
      text: 'Hello {{run.user}}',
    };
    const values = new Map([['user', 'Ada']]) as never;
    const original = structuredClone(assertion);

    const result = materializeAssertionForCoverage(assertion, { values });

    expect(result).toEqual({ ...assertion, text: 'Hello Ada' });
    expect(assertion).toEqual(original);
    expect([...values]).toEqual([['user', 'Ada']]);
  });

  it('preserves full structured assertion fields and canonical equality ignores object key order', () => {
    const first = { type: 'assert' as const, check: 'element-count' as const, target: TARGET, count: 0 };
    const second = { count: 0, target: { name: 'Ready', role: 'status', strategy: 'accessibility' as const }, check: 'element-count' as const, type: 'assert' as const };

    const firstText = toCanonicalArtifactText(
      materializeAssertionForCoverage(first, { values: new Map() }) as unknown as JsonValueT,
    );
    const secondText = toCanonicalArtifactText(
      materializeAssertionForCoverage(second, { values: new Map() }) as unknown as JsonValueT,
    );
    expect(firstText).toBe(secondText);
  });
});

describe('classifyPreScannedTraceCoverage', () => {
  const criteria = [trusted('ready', 'Ready')];

  it('classifies absent additive coverage as a safe legacy cache miss', () => {
    const trace = preScanned({ events: [], verification: [READY_ASSERTION] });
    const result = expectSuccess(classifyPreScannedTraceCoverage({
      trace,
      criteria,
      runValues: { values: new Map() },
    }));

    expect(result).toEqual({ kind: 'legacy-cache-miss', priorTrace: trace });
  });

  it('accepts exact success-to-terminal-index coverage including prototype-shaped IDs', () => {
    const prototypeCriteria = [trusted('constructor', 'Ready')];
    const trace = preScanned({
      events: [],
      verification: [READY_ASSERTION],
      verificationCoverage: { constructor: 0 },
    });
    const result = expectSuccess(classifyPreScannedTraceCoverage({
      trace,
      criteria: prototypeCriteria,
      runValues: { values: new Map() },
    }));

    expect(result.kind).toBe('covered');
  });

  it.each([
    ['missing ID', {}, ['verification-coverage-id-missing']],
    ['unknown ID', { ready: 0, unknown: 1 }, ['verification-coverage-id-unknown', 'verification-coverage-index-invalid']],
    ['gap', { ready: 1 }, ['verification-coverage-index-invalid']],
    ['negative index', { ready: -1 }, ['verification-coverage-index-invalid']],
  ] as const)('rejects %s in verification coverage', (_name, verificationCoverage, codes) => {
    expectIssueCodes(classifyPreScannedTraceCoverage({
      trace: preScanned({ events: [], verification: [READY_ASSERTION], verificationCoverage }),
      criteria,
      runValues: { values: new Map() },
    }), codes);
  });

  it('rejects coverage that leaves a terminal verification index unmapped', () => {
    expectIssueCodes(classifyPreScannedTraceCoverage({
      trace: preScanned({
        events: [],
        verification: [READY_ASSERTION, { ...READY_ASSERTION, text: 'Account ready' }],
        verificationCoverage: { ready: 0 },
      }),
      criteria,
      runValues: { values: new Map() },
    }), ['verification-coverage-index-invalid']);
  });

  it('rejects duplicate terminal indices and action IDs', () => {
    expectIssueCodes(classifyPreScannedTraceCoverage({
      trace: preScanned({
        events: [],
        verification: [READY_ASSERTION, { ...READY_ASSERTION, text: 'Done' }],
        verificationCoverage: { first: 0, second: 0 },
      }),
      criteria: [trusted('first', 'Ready'), trusted('second', 'Done')],
      runValues: { values: new Map() },
    }), ['verification-coverage-index-duplicate', 'verification-coverage-index-invalid']);

    expectIssueCodes(classifyPreScannedTraceCoverage({
      trace: preScanned({
        events: [],
        verification: [READY_ASSERTION],
        verificationCoverage: { click: 0, ready: 0 },
      }),
      criteria: [trusted('click', 'Click', 'action'), trusted('ready', 'Ready')],
      runValues: { values: new Map() },
    }), ['verification-coverage-id-action', 'verification-coverage-index-duplicate']);
  });

  it('rejects terminal url-matches', () => {
    expectIssueCodes(classifyPreScannedTraceCoverage({
      trace: preScanned({
        events: [],
        verification: [{ type: 'assert', check: 'url-matches', pattern: '/ready$' }],
        verificationCoverage: { ready: 0 },
      }),
      criteria,
      runValues: { values: new Map() },
    }), ['terminal-url-matches-forbidden']);
  });

  it('rejects a terminal assertion repeated from events after run-value materialization', () => {
    expectIssueCodes(classifyPreScannedTraceCoverage({
      trace: preScanned({
        events: [{ type: 'assert', check: 'text-visible', text: 'Hello {{run.user}}' }],
        verification: [{ type: 'assert', check: 'text-visible', text: 'Hello Ada' }],
        verificationCoverage: { ready: 0 },
      }),
      criteria,
      runValues: { values: new Map([['user', 'Ada']]) as never },
    }), ['verification-assertion-repeated']);
  });

  it('compares the full assertion value, not only its check discriminant', () => {
    const result = expectSuccess(classifyPreScannedTraceCoverage({
      trace: preScanned({
        events: [{ type: 'assert', check: 'text-visible', text: 'Loading' }],
        verification: [READY_ASSERTION],
        verificationCoverage: { ready: 0 },
      }),
      criteria,
      runValues: { values: new Map() },
    }));

    expect(result.kind).toBe('covered');
  });

  it.each([
    ['text-visible repeated after run substitution',
      { type: 'assert', check: 'text-visible', text: 'Hello {{run.user}}' },
      { type: 'assert', check: 'text-visible', text: 'Hello Ada' }, true],
    ['text-visible neighboring text',
      { type: 'assert', check: 'text-visible', text: 'Hello Ada' },
      { type: 'assert', check: 'text-visible', text: 'Hello Grace' }, false],
    ['text-equals repeated despite key order',
      { type: 'assert', check: 'text-equals', target: TARGET, text: 'Ready' },
      { text: 'Ready', target: { name: 'Ready', role: 'status', strategy: 'accessibility' }, check: 'text-equals', type: 'assert' }, true],
    ['text-equals neighboring target name',
      { type: 'assert', check: 'text-equals', target: TARGET, text: 'Ready' },
      { type: 'assert', check: 'text-equals', target: { ...TARGET, name: 'Other' }, text: 'Ready' }, false],
    ['element-visible repeated despite key order',
      { type: 'assert', check: 'element-visible', target: TARGET },
      { target: { name: 'Ready', role: 'status', strategy: 'accessibility' }, check: 'element-visible', type: 'assert' }, true],
    ['element-visible neighboring target role',
      { type: 'assert', check: 'element-visible', target: TARGET },
      { type: 'assert', check: 'element-visible', target: { ...TARGET, role: 'alert' } }, false],
    ['element-count repeated at exact zero',
      { type: 'assert', check: 'element-count', target: TARGET, count: 0 },
      { count: 0, target: { name: 'Ready', role: 'status', strategy: 'accessibility' }, check: 'element-count', type: 'assert' }, true],
    ['element-count neighboring count',
      { type: 'assert', check: 'element-count', target: TARGET, count: 0 },
      { type: 'assert', check: 'element-count', target: TARGET, count: 1 }, false],
  ] as const)(
    '%s uses the complete materialized canonical descriptor',
    (_name, event, terminal, repeated) => {
      const result = classifyPreScannedTraceCoverage({
        trace: preScanned({
          events: [event as TraceAssert],
          verification: [terminal as TraceAssert],
          verificationCoverage: { ready: 0 },
        }),
        criteria,
        runValues: { values: new Map([['user', 'Ada']]) as never },
      });
      if (repeated) {
        expectIssueCodes(result, ['verification-assertion-repeated']);
      } else {
        expectSuccess(result);
      }
    },
  );

  it('accepts exact element-count zero as terminal proof unless it repeats an event', () => {
    const zero = { type: 'assert' as const, check: 'element-count' as const, target: TARGET, count: 0 };
    expectSuccess(classifyPreScannedTraceCoverage({
      trace: preScanned({ events: [], verification: [zero], verificationCoverage: { ready: 0 } }),
      criteria,
      runValues: { values: new Map() },
    }));
    expectIssueCodes(classifyPreScannedTraceCoverage({
      trace: preScanned({ events: [zero], verification: [zero], verificationCoverage: { ready: 0 } }),
      criteria,
      runValues: { values: new Map() },
    }), ['verification-assertion-repeated']);
  });
});
