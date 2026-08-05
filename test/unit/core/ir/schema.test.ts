import { describe, expect, it } from 'vitest';
import {
  AccessibilityElementRef,
  ActionStep,
  AiStep,
  AssertStep,
  CaptureStep,
  ClickAction,
  ElementCountCheck,
  ElementRef,
  ElementVisibleCheck,
  FillAction,
  FillSecretAction,
  Fingerprint,
  GroundingDocument,
  HexSha256,
  InterpolatableText,
  JsonValue,
  NavigateAction,
  PlanDocument,
  PressAction,
  RunRef,
  RunVariableName,
  SecretRef,
  Step,
  StepId,
  TargetDefinition,
  TextEqualsCheck,
  TextVisibleCheck,
  Trace,
  TraceAction,
  TraceClick,
  TraceFill,
  TraceFillSecret,
  TraceNavigate,
  TracePress,
  UrlMatchesCheck,
} from '../../../../src/core/ir/schema.js';

interface SchemaUnderTest {
  safeParse(value: unknown): { success: boolean };
}

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const TARGET = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const TARGET_DEFINITION = { baseUrl: 'https://example.test', browser: 'chromium' };

function expectAccepted(schema: SchemaUnderTest, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(true);
}

function expectRejected(schema: SchemaUnderTest, value: unknown): void {
  expect(schema.safeParse(value).success).toBe(false);
}

function plan(steps: unknown[], targets: Record<string, unknown> = { app: TARGET_DEFINITION }): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: { inputsDigest: DIGEST_A },
    targets,
    steps,
  };
}

describe('IR primitive schemas', () => {
  it('accepts whole secret references and rejects malformed secret references', () => {
    expectAccepted(SecretRef, '{{secrets.production.password}}');
    expectAccepted(SecretRef, '{{secrets.prod_config.api_key_2}}');

    for (const malformed of [
      'secrets.production.password',
      '{{secret.production.password}}',
      'pre-{{secrets.production.password}}-post',
      '{{secrets.production.password-name}}',
      '{{secrets.}}',
    ]) {
      expectRejected(SecretRef, malformed);
    }
  });

  it('accepts whole run references and rejects malformed run references', () => {
    expectAccepted(RunRef, '{{run.profile.name}}');
    expectAccepted(RunRef, '{{run.prod_config.api_key_2}}');

    for (const malformed of [
      'run.profile.name',
      '{{runs.profile.name}}',
      'pre-{{run.profile.name}}-post',
      '{{run.profile-name}}',
      '{{run.}}',
    ]) {
      expectRejected(RunRef, malformed);
    }
  });

  it('allows ordinary and run-interpolated free text but never secret interpolation', () => {
    expectAccepted(InterpolatableText, 'Welcome, {{run.profile.name}}!');
    expectAccepted(InterpolatableText, 'こんにちは、世界');
    expectRejected(InterpolatableText, 'Welcome, {{secrets.app.password}}!');
  });

  it('enforces lowercase SHA-256 digest syntax', () => {
    expectAccepted(HexSha256, DIGEST_A);
    expectRejected(HexSha256, 'a'.repeat(63));
    expectRejected(HexSha256, 'A'.repeat(64));
    expectRejected(HexSha256, 42);
  });

  it('accepts descriptive step ids and rejects sequential numeric ids', () => {
    expectAccepted(StepId, 'a');
    expectAccepted(StepId, 'fill-otp-6-digit-code');

    for (const invalidId of ['1', '1-2', '123abc', 'has_underscore', 'ends-']) {
      expectRejected(StepId, invalidId);
    }
  });

  it('distinguishes capture variable names from consumer run references', () => {
    expectAccepted(RunVariableName, 'welcomeText');
    expectRejected(RunVariableName, 'WelcomeText');
    expectRejected(RunVariableName, 'welcome_text');
    expectRejected(RunVariableName, '{{run.welcomeText}}');
  });

  it('accepts recursively serializable compiler metadata and rejects non-JSON values', () => {
    expectAccepted(JsonValue, { string: 'value', array: [true, null, { number: 1 }] });
    expectRejected(JsonValue, undefined);
    expectRejected(JsonValue, BigInt(1));
    expectRejected(JsonValue, () => undefined);
  });
});

describe('TargetDefinition', () => {
  it('accepts the Chromium HTTP(S) target definition', () => {
    expectAccepted(TargetDefinition, TARGET_DEFINITION);
    expectAccepted(TargetDefinition, { baseUrl: 'http://example.test', browser: 'chromium' });
    expectAccepted(TargetDefinition, { baseUrl: 'https://example.test/path?query=value#section', browser: 'chromium' });
  });

  it('rejects malformed or non-HTTP URLs, embedded secret references, unsupported browsers, wrong field types, and unknown properties', () => {
    expectRejected(TargetDefinition, { baseUrl: 'ftp://example.test', browser: 'chromium' });
    for (const hostlessUrl of ['https://?', 'https:///path', 'http://', 'http://#fragment']) {
      expectRejected(TargetDefinition, { baseUrl: hostlessUrl, browser: 'chromium' });
    }
    expectRejected(TargetDefinition, { baseUrl: 'https://example.com/{{secrets.TOKEN}}', browser: 'chromium' });
    expectRejected(TargetDefinition, { baseUrl: 'https://example.test', browser: 'firefox' });
    expectRejected(TargetDefinition, { baseUrl: 42, browser: 'chromium' });
    expectRejected(TargetDefinition, { ...TARGET_DEFINITION, unexpected: true });
  });
});

describe('ElementRef', () => {
  it('accepts the accessibility strategy through both its concrete and union schemas', () => {
    expectAccepted(AccessibilityElementRef, TARGET);
    expectAccepted(ElementRef, TARGET);
  });

  it('rejects unknown or missing strategies, non-string fields, empty role or name, and nested extras', () => {
    expectRejected(ElementRef, { strategy: 'css', selector: '#submit' });
    expectRejected(ElementRef, { role: 'button', name: 'Submit' });
    expectRejected(ElementRef, { strategy: 'accessibility', role: 1, name: 'Submit' });
    expectRejected(ElementRef, { strategy: 'accessibility', role: '', name: 'Submit' });
    expectRejected(ElementRef, { strategy: 'accessibility', role: 'button', name: '' });
    expectRejected(AccessibilityElementRef, { ...TARGET, unexpected: true });
  });
});

describe('Fingerprint', () => {
  it('accepts a versioned accessibility-neighborhood SHA-256 fingerprint', () => {
    expectAccepted(Fingerprint, { algorithm: 'a11y-neighborhood-v1', hash: DIGEST_A });
  });

  it('rejects an unknown algorithm, invalid hash, wrong field type, and unknown property', () => {
    expectRejected(Fingerprint, { algorithm: 'dom-v1', hash: DIGEST_A });
    expectRejected(Fingerprint, { algorithm: 'a11y-neighborhood-v1', hash: 'a'.repeat(63) });
    expectRejected(Fingerprint, { algorithm: 'a11y-neighborhood-v1', hash: 1 });
    expectRejected(Fingerprint, { algorithm: 'a11y-neighborhood-v1', hash: DIGEST_A, unexpected: true });
  });
});

const actionVariants: ReadonlyArray<readonly [string, SchemaUnderTest, unknown]> = [
  ['click', ClickAction, { id: 'click-submit', kind: 'action', action: 'click', target: TARGET }],
  ['navigate', NavigateAction, { id: 'navigate-home', kind: 'action', action: 'navigate', url: 'https://example.test' }],
  ['press', PressAction, { id: 'press-enter', kind: 'action', action: 'press', target: TARGET, key: 'Enter' }],
  ['fill', FillAction, { id: 'fill-email', kind: 'action', action: 'fill', target: TARGET, value: 'person@example.test' }],
  ['fill-secret', FillSecretAction, { id: 'fill-password', kind: 'action', action: 'fill-secret', target: TARGET, secretRef: '{{secrets.app.password}}' }],
];

describe('ActionStep', () => {
  it.each(actionVariants)('accepts the %s action in its concrete, action, and outer step schemas', (_name, schema, value) => {
    expectAccepted(schema, value);
    expectAccepted(ActionStep, value);
    expectAccepted(Step, value);
  });

  it('rejects unknown or missing action discriminants', () => {
    expectRejected(ActionStep, { id: 'scroll', kind: 'action', action: 'scroll' });
    expectRejected(ActionStep, { id: 'missing-action', kind: 'action', url: 'https://example.test' });
  });

  it.each([
    ['ClickAction.target', ClickAction, [
      { id: 'click-submit', kind: 'action', action: 'click', target: 'Submit' },
      { id: 'click-submit', kind: 'action', action: 'click' },
    ]],
    ['NavigateAction.url', NavigateAction, [
      { id: 'navigate-home', kind: 'action', action: 'navigate', url: 42 },
      { id: 'navigate-home', kind: 'action', action: 'navigate', url: 'https://{{secrets.app.password}}' },
      { id: 'navigate-home', kind: 'action', action: 'navigate' },
    ]],
    ['PressAction.target', PressAction, [
      { id: 'press-enter', kind: 'action', action: 'press', target: 'Submit', key: 'Enter' },
      { id: 'press-enter', kind: 'action', action: 'press', key: 'Enter' },
    ]],
    ['PressAction.key', PressAction, [
      { id: 'press-enter', kind: 'action', action: 'press', target: TARGET, key: 1 },
      { id: 'press-enter', kind: 'action', action: 'press', target: TARGET, key: 'Space' },
      { id: 'press-enter', kind: 'action', action: 'press', target: TARGET },
    ]],
    ['FillAction.target', FillAction, [
      { id: 'fill-email', kind: 'action', action: 'fill', target: 'Email', value: 'person@example.test' },
      { id: 'fill-email', kind: 'action', action: 'fill', value: 'person@example.test' },
    ]],
    ['FillAction.value', FillAction, [
      { id: 'fill-email', kind: 'action', action: 'fill', target: TARGET, value: 42 },
      { id: 'fill-email', kind: 'action', action: 'fill', target: TARGET, value: 'Use {{secrets.app.password}}' },
      { id: 'fill-email', kind: 'action', action: 'fill', target: TARGET },
    ]],
    ['FillSecretAction.target', FillSecretAction, [
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: 'Password', secretRef: '{{secrets.app.password}}' },
      { id: 'fill-password', kind: 'action', action: 'fill-secret', secretRef: '{{secrets.app.password}}' },
    ]],
    ['FillSecretAction.secretRef', FillSecretAction, [
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: TARGET, secretRef: 42 },
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: TARGET, secretRef: 'hunter2' },
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: TARGET },
    ]],
  ] as const)('rejects wrong or missing values for %s', (_field, schema, invalidValues) => {
    for (const invalidValue of invalidValues) {
      expectRejected(schema, invalidValue);
    }
  });

  it.each(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'] as const)('accepts the %s PressAction key enum value', (key) => {
    expectAccepted(PressAction, { id: 'press-key', kind: 'action', action: 'press', target: TARGET, key });
  });

  it('rejects literal, malformed, and embedded secret text in fill-secret fields', () => {
    for (const secretRef of ['hunter2', '{{secret.app.password}}', 'pre-{{secrets.app.password}}-post']) {
      expectRejected(FillSecretAction, {
        id: 'fill-password',
        kind: 'action',
        action: 'fill-secret',
        target: TARGET,
        secretRef,
      });
    }
  });

  it('accepts embedded run interpolation while rejecting embedded secret interpolation in fill values', () => {
    expectAccepted(FillAction, {
      id: 'fill-name',
      kind: 'action',
      action: 'fill',
      target: TARGET,
      value: 'Hello {{run.username}}',
    });
    expectRejected(FillAction, {
      id: 'fill-password',
      kind: 'action',
      action: 'fill',
      target: TARGET,
      value: 'before {{secrets.app.password}} after',
    });
  });
});

const assertVariants: ReadonlyArray<readonly [string, SchemaUnderTest, unknown]> = [
  ['text-visible', TextVisibleCheck, { id: 'welcome-visible', kind: 'assert', check: 'text-visible', text: 'Welcome' }],
  ['element-visible', ElementVisibleCheck, { id: 'dashboard-visible', kind: 'assert', check: 'element-visible', target: TARGET }],
  ['text-equals', TextEqualsCheck, { id: 'heading-text', kind: 'assert', check: 'text-equals', target: TARGET, text: 'Welcome' }],
  ['url-matches', UrlMatchesCheck, { id: 'dashboard-url', kind: 'assert', check: 'url-matches', pattern: '/dashboard$' }],
  ['element-count', ElementCountCheck, { id: 'zero-alerts', kind: 'assert', check: 'element-count', target: TARGET, count: 0 }],
];

describe('AssertStep', () => {
  it.each(assertVariants)('accepts the %s check in its concrete, assert, and outer step schemas', (_name, schema, value) => {
    expectAccepted(schema, value);
    expectAccepted(AssertStep, value);
    expectAccepted(Step, value);
  });

  it('rejects unknown or missing check discriminants', () => {
    expectRejected(AssertStep, { id: 'page-ready', kind: 'assert', check: 'page-ready' });
    expectRejected(AssertStep, { id: 'missing-check', kind: 'assert', text: 'Ready' });
  });

  it.each([
    ['TextVisibleCheck.text', TextVisibleCheck, [
      { id: 'welcome-visible', kind: 'assert', check: 'text-visible', text: 42 },
      { id: 'welcome-visible', kind: 'assert', check: 'text-visible', text: 'Use {{secrets.app.password}}' },
      { id: 'welcome-visible', kind: 'assert', check: 'text-visible' },
    ]],
    ['ElementVisibleCheck.target', ElementVisibleCheck, [
      { id: 'dashboard-visible', kind: 'assert', check: 'element-visible', target: 'Dashboard' },
      { id: 'dashboard-visible', kind: 'assert', check: 'element-visible' },
    ]],
    ['TextEqualsCheck.target', TextEqualsCheck, [
      { id: 'heading-text', kind: 'assert', check: 'text-equals', target: 'Heading', text: 'Welcome' },
      { id: 'heading-text', kind: 'assert', check: 'text-equals', text: 'Welcome' },
    ]],
    ['TextEqualsCheck.text', TextEqualsCheck, [
      { id: 'heading-text', kind: 'assert', check: 'text-equals', target: TARGET, text: 42 },
      { id: 'heading-text', kind: 'assert', check: 'text-equals', target: TARGET, text: 'Use {{secrets.app.password}}' },
      { id: 'heading-text', kind: 'assert', check: 'text-equals', target: TARGET },
    ]],
    ['UrlMatchesCheck.pattern', UrlMatchesCheck, [
      { id: 'dashboard-url', kind: 'assert', check: 'url-matches', pattern: 42 },
      { id: 'dashboard-url', kind: 'assert', check: 'url-matches', pattern: 'Use {{secrets.app.password}}' },
      { id: 'dashboard-url', kind: 'assert', check: 'url-matches' },
    ]],
    ['ElementCountCheck.target', ElementCountCheck, [
      { id: 'zero-alerts', kind: 'assert', check: 'element-count', target: 'Alert', count: 0 },
      { id: 'zero-alerts', kind: 'assert', check: 'element-count', count: 0 },
    ]],
    ['ElementCountCheck.count', ElementCountCheck, [
      { id: 'zero-alerts', kind: 'assert', check: 'element-count', target: TARGET, count: '0' },
      { id: 'zero-alerts', kind: 'assert', check: 'element-count', target: TARGET, count: -1 },
      { id: 'zero-alerts', kind: 'assert', check: 'element-count', target: TARGET },
    ]],
  ] as const)('rejects wrong or missing values for %s', (_field, schema, invalidValues) => {
    for (const invalidValue of invalidValues) {
      expectRejected(schema, invalidValue);
    }
  });

  it('enforces a non-negative integer element count', () => {
    expectAccepted(ElementCountCheck, { id: 'zero-alerts', kind: 'assert', check: 'element-count', target: TARGET, count: 0 });
    expectRejected(ElementCountCheck, { id: 'negative-alerts', kind: 'assert', check: 'element-count', target: TARGET, count: -1 });
    expectRejected(ElementCountCheck, { id: 'fractional-alerts', kind: 'assert', check: 'element-count', target: TARGET, count: 1.5 });
  });

  it('accepts unicode and multi-line text while rejecting contiguous secret interpolation in assertion text', () => {
    expectAccepted(TextVisibleCheck, { id: 'japanese-visible', kind: 'assert', check: 'text-visible', text: 'ようこそ、世界' });
    expectAccepted(TextVisibleCheck, { id: 'run-visible', kind: 'assert', check: 'text-visible', text: 'Hello {{run.username}}' });
    expectRejected(TextVisibleCheck, { id: 'secret-visible', kind: 'assert', check: 'text-visible', text: 'Hello {{secrets.app.password}}' });
    expectAccepted(TextVisibleCheck, { id: 'multiline-visible', kind: 'assert', check: 'text-visible', text: 'Line one\nLine two' });
    expectRejected(TextVisibleCheck, { id: 'multiline-secret-first', kind: 'assert', check: 'text-visible', text: '{{secrets.TOKEN}}\ntext' });
    expectRejected(TextVisibleCheck, { id: 'multiline-secret-later', kind: 'assert', check: 'text-visible', text: 'text\n{{secrets.TOKEN}}' });
    expectAccepted(TextVisibleCheck, { id: 'multiline-split-marker', kind: 'assert', check: 'text-visible', text: 'text\n{{secrets\n.TOKEN}}' });
  });
});

describe('CaptureStep and AiStep', () => {
  it('accepts capture and AI steps through their concrete and outer schemas', () => {
    const capture = { id: 'capture-welcome', kind: 'capture', target: TARGET, variable: 'welcomeText' };
    const ai = { id: 'find-settings', kind: 'ai', instruction: 'Open settings', trace: [{ type: 'click', target: TARGET }] };

    expectAccepted(CaptureStep, capture);
    expectAccepted(AiStep, ai);
    expectAccepted(Step, capture);
    expectAccepted(Step, ai);
  });

  it.each([
    ['CaptureStep.target', CaptureStep, [
      { id: 'capture-welcome', kind: 'capture', target: 'Welcome message', variable: 'welcomeText' },
      { id: 'capture-welcome', kind: 'capture', variable: 'welcomeText' },
    ]],
    ['CaptureStep.variable', CaptureStep, [
      { id: 'capture-welcome', kind: 'capture', target: TARGET, variable: 42 },
      { id: 'capture-welcome', kind: 'capture', target: TARGET, variable: 'WelcomeText' },
      { id: 'capture-welcome', kind: 'capture', target: TARGET },
    ]],
    ['AiStep.instruction', AiStep, [
      { id: 'find-settings', kind: 'ai', instruction: 42 },
      { id: 'find-settings', kind: 'ai', instruction: 'Use {{secrets.app.password}}' },
      { id: 'find-settings', kind: 'ai' },
    ]],
  ] as const)('rejects wrong or missing values for %s', (_field, schema, invalidValues) => {
    for (const invalidValue of invalidValues) {
      expectRejected(schema, invalidValue);
    }
  });

  it('rejects AI unknown properties', () => {
    expectRejected(AiStep, { id: 'find-settings', kind: 'ai', instruction: 'Open settings', unexpected: true });
  });

  it('accepts unicode and run interpolation in AI instructions', () => {
    expectAccepted(AiStep, { id: 'ai-unicode', kind: 'ai', instruction: '設定を開く: {{run.username}}' });
  });

  it('rejects unknown and missing outer kind discriminants', () => {
    expectRejected(Step, { id: 'wait', kind: 'wait' });
    expectRejected(Step, { id: 'missing-kind', action: 'navigate', url: 'https://example.test' });
  });
});

const traceVariants: ReadonlyArray<readonly [string, SchemaUnderTest, unknown]> = [
  ['click', TraceClick, { type: 'click', target: TARGET }],
  ['navigate', TraceNavigate, { type: 'navigate', url: 'https://example.test' }],
  ['press', TracePress, { type: 'press', target: TARGET, key: 'Tab' }],
  ['fill', TraceFill, { type: 'fill', target: TARGET, value: 'person@example.test' }],
  ['fill-secret', TraceFillSecret, { type: 'fill-secret', target: TARGET, secretRef: '{{secrets.app.password}}' }],
];

describe('TraceAction and Trace', () => {
  it.each(traceVariants)('accepts the %s trace action in its concrete and union schemas', (_name, schema, value) => {
    expectAccepted(schema, value);
    expectAccepted(TraceAction, value);
  });

  it('rejects unknown or missing trace discriminants', () => {
    expectRejected(TraceAction, { type: 'scroll' });
    expectRejected(TraceAction, { url: 'https://example.test' });
  });

  it.each([
    ['TraceClick.target', TraceClick, [
      { type: 'click', target: 'Submit' },
      { type: 'click' },
    ]],
    ['TraceNavigate.url', TraceNavigate, [
      { type: 'navigate', url: 42 },
      { type: 'navigate', url: 'https://{{secrets.app.password}}' },
      { type: 'navigate' },
    ]],
    ['TracePress.target', TracePress, [
      { type: 'press', target: 'Submit', key: 'Enter' },
      { type: 'press', key: 'Enter' },
    ]],
    ['TracePress.key', TracePress, [
      { type: 'press', target: TARGET, key: 1 },
      { type: 'press', target: TARGET, key: 'Space' },
      { type: 'press', target: TARGET },
    ]],
    ['TraceFill.target', TraceFill, [
      { type: 'fill', target: 'Email', value: 'person@example.test' },
      { type: 'fill', value: 'person@example.test' },
    ]],
    ['TraceFill.value', TraceFill, [
      { type: 'fill', target: TARGET, value: 42 },
      { type: 'fill', target: TARGET, value: 'Use {{secrets.app.password}}' },
      { type: 'fill', target: TARGET },
    ]],
    ['TraceFillSecret.target', TraceFillSecret, [
      { type: 'fill-secret', target: 'Password', secretRef: '{{secrets.app.password}}' },
      { type: 'fill-secret', secretRef: '{{secrets.app.password}}' },
    ]],
    ['TraceFillSecret.secretRef', TraceFillSecret, [
      { type: 'fill-secret', target: TARGET, secretRef: 42 },
      { type: 'fill-secret', target: TARGET, secretRef: 'hunter2' },
      { type: 'fill-secret', target: TARGET },
    ]],
  ] as const)('rejects wrong or missing values for %s', (_field, schema, invalidValues) => {
    for (const invalidValue of invalidValues) {
      expectRejected(schema, invalidValue);
    }
  });

  it.each(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'] as const)('accepts the %s TracePress key enum value', (key) => {
    expectAccepted(TracePress, { type: 'press', target: TARGET, key });
  });

  it('accepts a populated trace and an empty trace', () => {
    expectAccepted(Trace, traceVariants.map(([, , value]) => value));
    expectAccepted(Trace, []);
  });
});

describe('PlanDocument', () => {
  it('accepts a plan combining action, assert, capture, and AI steps', () => {
    expectAccepted(PlanDocument, plan([
      { id: 'open-home', kind: 'action', action: 'navigate', url: 'https://example.test' },
      { id: 'welcome-visible', kind: 'assert', check: 'text-visible', text: 'Welcome' },
      { id: 'capture-welcome', kind: 'capture', target: TARGET, variable: 'welcomeText' },
      { id: 'continue-with-ai', kind: 'ai', instruction: 'Continue after {{run.welcomeText}}' },
    ]));
  });

  it('accepts empty steps with both empty and one-entry target records', () => {
    expectAccepted(PlanDocument, plan([], {}));
    expectAccepted(PlanDocument, plan([], { app: TARGET_DEFINITION }));
  });

  it('accepts JSON-only compiler metadata recursively', () => {
    expectAccepted(PlanDocument, {
      ...plan([]),
      compilerMeta: { model: 'compiler', attempt: 1, values: [true, null, { nested: 'value' }] },
    });
  });

  it('rejects duplicate step ids through zod-only semantic validation', () => {
    expectRejected(PlanDocument, plan([
      { id: 'same-id', kind: 'action', action: 'navigate', url: 'https://example.test/one' },
      { id: 'same-id', kind: 'assert', check: 'text-visible', text: 'Second' },
    ]));
  });

  it('rejects wrong document fields and unknown properties at plan and target nesting levels', () => {
    expectRejected(PlanDocument, { ...plan([]), schemaVersion: '1' });
    expectRejected(PlanDocument, { ...plan([]), source: { inputsDigest: 'A'.repeat(64) } });
    expectRejected(PlanDocument, { ...plan([]), compilerMeta: { unsupported: undefined } });
    expectRejected(PlanDocument, { ...plan([]), unexpected: true });
    expectRejected(PlanDocument, plan([], { app: { ...TARGET_DEFINITION, unexpected: true } }));
  });
});

describe('GroundingDocument', () => {
  it('accepts a grounding entry with a fingerprint and populated trace', () => {
    expectAccepted(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        'login-flow': {
          fingerprint: { algorithm: 'a11y-neighborhood-v1', hash: DIGEST_A },
          trace: traceVariants.map(([, , value]) => value),
        },
      },
    });
  });

  it('rejects wrong document fields, invalid entry keys, and unknown properties', () => {
    expectRejected(GroundingDocument, { schemaVersion: 1, planDigest: 'b'.repeat(63), entries: {} });
    expectRejected(GroundingDocument, { schemaVersion: 1, planDigest: DIGEST_B, entries: { '1': { fingerprint: { algorithm: 'a11y-neighborhood-v1', hash: DIGEST_A } } } });
    expectRejected(GroundingDocument, { schemaVersion: 1, planDigest: DIGEST_B, entries: {}, unexpected: true });
    expectRejected(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        step: { fingerprint: { algorithm: 'a11y-neighborhood-v1', hash: DIGEST_A }, unexpected: true },
      },
    });
  });
});
