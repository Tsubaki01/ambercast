import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toCanonicalArtifactText } from '../../../../src/core/ir/canonical-json.js';
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
  GeneratedAiStep,
  GeneratedFillSecretAction,
  GeneratedPlanResponse,
  GeneratedStep,
  HexSha256,
  InterpolatableText,
  JsonValue,
  NavigateAction,
  PlanDocument,
  PressAction,
  RunRef,
  RunVariableName,
  SecretRef,
  SourceSpan,
  Step,
  StepId,
  TargetDefinition,
  TextEqualsCheck,
  TextVisibleCheck,
  TraceAction,
  TraceAssert,
  TraceClick,
  TraceEntry,
  TraceFill,
  TraceFillSecret,
  TraceNavigate,
  TracePress,
  TraceRecord,
  UrlMatchesCheck,
} from '../../../../src/core/ir/schema.js';
import type { JsonValueT } from '../../../../src/core/ir/schema.js';

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

function expectZodAndJsonSchemaVerdict(schema: SchemaUnderTest, value: unknown, expected: boolean): void {
  const validate = new Ajv2020({ strict: true }).compile(z.toJSONSchema(schema as never));

  expect(schema.safeParse(value).success).toBe(expected);
  expect(validate(value)).toBe(expected);
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

  it('accepts recursively serializable generator metadata and rejects non-JSON values', () => {
    expectAccepted(JsonValue, { string: 'value', array: [true, null, { number: 1 }] });
    expectRejected(JsonValue, undefined);
    expectRejected(JsonValue, BigInt(1));
    expectRejected(JsonValue, () => undefined);
  });

  it('accepts positive inclusive source spans and rejects malformed strict objects', () => {
    expectAccepted(SourceSpan, { startLine: 1, endLine: 1 });

    for (const value of [
      { endLine: 1 },
      { startLine: 1 },
      { startLine: 1.5, endLine: 2 },
      { startLine: 0, endLine: 1 },
      { startLine: -1, endLine: 1 },
      { startLine: 1, endLine: 1.5 },
      { startLine: 1, endLine: 0 },
      { startLine: 1, endLine: -1 },
      { startLine: 1, endLine: 1, unexpected: true },
    ]) {
      expectRejected(SourceSpan, value);
    }
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
    expectAccepted(Fingerprint, { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A });
  });

  it('rejects the retired a11y-neighborhood-v1 algorithm', () => {
    expectRejected(Fingerprint, { algorithm: 'a11y-neighborhood-v1', hash: DIGEST_A });
  });

  it('rejects an unknown algorithm, invalid hash, wrong field type, and unknown property', () => {
    expectRejected(Fingerprint, { algorithm: 'dom-v1', hash: DIGEST_A });
    expectRejected(Fingerprint, { algorithm: 'a11y-neighborhood-v2', hash: 'a'.repeat(63) });
    expectRejected(Fingerprint, { algorithm: 'a11y-neighborhood-v2', hash: 1 });
    expectRejected(Fingerprint, { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A, unexpected: true });
  });
});

const actionVariants: ReadonlyArray<readonly [string, SchemaUnderTest, unknown]> = [
  ['click', ClickAction, { id: 'click-submit', kind: 'action', action: 'click', target: TARGET }],
  ['navigate', NavigateAction, { id: 'navigate-home', kind: 'action', action: 'navigate', url: 'https://example.test' }],
  ['press', PressAction, { id: 'press-enter', kind: 'action', action: 'press', target: TARGET, key: 'Enter' }],
  ['fill', FillAction, { id: 'fill-email', kind: 'action', action: 'fill', target: TARGET, value: 'person@example.test' }],
  ['fill-secret', FillSecretAction, { id: 'fill-password', kind: 'action', action: 'fill-secret', target: TARGET, secretRef: '{{secrets.app.password}}', secretGrantSpan: { startLine: 4, endLine: 4 } }],
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
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: 'Password', secretRef: '{{secrets.app.password}}', secretGrantSpan: { startLine: 1, endLine: 1 } },
      { id: 'fill-password', kind: 'action', action: 'fill-secret', secretRef: '{{secrets.app.password}}', secretGrantSpan: { startLine: 1, endLine: 1 } },
    ]],
    ['FillSecretAction.secretRef', FillSecretAction, [
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: TARGET, secretRef: 42, secretGrantSpan: { startLine: 1, endLine: 1 } },
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: TARGET, secretRef: 'hunter2', secretGrantSpan: { startLine: 1, endLine: 1 } },
      { id: 'fill-password', kind: 'action', action: 'fill-secret', target: TARGET, secretGrantSpan: { startLine: 1, endLine: 1 } },
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
        secretGrantSpan: { startLine: 1, endLine: 1 },
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

  it.each([
    ['text-visible', { id: 'welcome-visible', kind: 'assert', check: 'text-visible', text: 'Welcome' }, { id: 'welcome-visible', kind: 'assert', check: 'text-visible' }],
    ['element-visible', { id: 'dashboard-visible', kind: 'assert', check: 'element-visible', target: TARGET }, { id: 'dashboard-visible', kind: 'assert', check: 'element-visible' }],
    ['text-equals', { id: 'heading-text', kind: 'assert', check: 'text-equals', target: TARGET, text: 'Welcome' }, { id: 'heading-text', kind: 'assert', check: 'text-equals', target: TARGET }],
    ['url-matches', { id: 'dashboard-url', kind: 'assert', check: 'url-matches', pattern: '/dashboard$' }, { id: 'dashboard-url', kind: 'assert', check: 'url-matches' }],
    ['element-count', { id: 'zero-alerts', kind: 'assert', check: 'element-count', target: TARGET, count: 0 }, { id: 'zero-alerts', kind: 'assert', check: 'element-count', target: TARGET, count: -1 }],
  ] as const)('keeps the %s assertion branch accept/reject behavior after field-bundle extraction', (_check, accepted, rejected) => {
    expectAccepted(AssertStep, accepted);
    expectRejected(AssertStep, rejected);
  });
});

describe('CaptureStep and AiStep', () => {
  it('accepts capture and AI steps through their concrete and outer schemas', () => {
    const capture = { id: 'capture-welcome', kind: 'capture', target: TARGET, variable: 'welcomeText' };
    const ai = { id: 'find-settings', kind: 'ai', instruction: 'Open settings' };

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

  it('rejects the retired trace property on AI steps', () => {
    expectRejected(AiStep, {
      id: 'find-settings',
      kind: 'ai',
      instruction: 'Open settings',
      trace: [{ type: 'click', target: TARGET }],
    });
  });

  it('accepts unicode and run interpolation in AI instructions', () => {
    expectAccepted(AiStep, { id: 'ai-unicode', kind: 'ai', instruction: '設定を開く: {{run.username}}' });
  });

  it('preserves omitted and explicitly empty AI secret grants as distinct serialized values', () => {
    const omitted = AiStep.parse({ id: 'find-settings', kind: 'ai', instruction: 'Open settings' });
    const explicitlyEmpty = AiStep.parse({ id: 'find-settings', kind: 'ai', instruction: 'Open settings', secrets: [] });
    const omittedText = toCanonicalArtifactText(omitted as JsonValueT);
    const explicitlyEmptyText = toCanonicalArtifactText(explicitlyEmpty as JsonValueT);

    expect(AiStep.parse(JSON.parse(omittedText))).toStrictEqual(omitted);
    expect(AiStep.parse(JSON.parse(explicitlyEmptyText))).toStrictEqual(explicitlyEmpty);
    expect(omittedText).not.toBe(explicitlyEmptyText);
    expect(JSON.parse(omittedText)).not.toHaveProperty('secrets');
    expect(JSON.parse(explicitlyEmptyText)).toHaveProperty('secrets', []);
  });

  it('accepts non-empty AI secret grants and rejects pre-attribution grant lists', () => {
    expectAccepted(AiStep, {
      id: 'find-settings',
      kind: 'ai',
      instruction: 'Open settings',
      secrets: [
        { ref: '{{secrets.app.token}}', sourceSpan: { startLine: 4, endLine: 4 } },
        { ref: '{{secrets.app.password}}', sourceSpan: { startLine: 6, endLine: 6 } },
      ],
    });
    expectRejected(AiStep, { id: 'find-settings', kind: 'ai', instruction: 'Open settings', secrets: '{{secrets.app.token}}' });
    expectRejected(AiStep, {
      id: 'find-settings',
      kind: 'ai',
      instruction: 'Open settings',
      secrets: ['{{secrets.app.token}}', '{{secret.app.password}}'],
    });
  });

  it('accepts distinct same-reference grants and rejects the old bare-reference shape', () => {
    expectAccepted(AiStep, {
      id: 'find-settings',
      kind: 'ai',
      instruction: 'Open settings',
      secrets: [
        { ref: '{{secrets.app.token}}', sourceSpan: { startLine: 4, endLine: 4 } },
        { ref: '{{secrets.app.token}}', sourceSpan: { startLine: 9, endLine: 9 } },
      ],
    });
    expectRejected(AiStep, {
      id: 'find-settings',
      kind: 'ai',
      instruction: 'Open settings',
      secrets: ['{{secrets.app.token}}'],
    });
    expectRejected(FillSecretAction, {
      id: 'fill-password',
      kind: 'action',
      action: 'fill-secret',
      target: TARGET,
      secretRef: '{{secrets.app.password}}',
    });
  });

  it('rejects unknown and missing outer kind discriminants', () => {
    expectRejected(Step, { id: 'wait', kind: 'wait' });
    expectRejected(Step, { id: 'missing-kind', action: 'navigate', url: 'https://example.test' });
  });
});

describe('provider-facing secret-grant schemas', () => {
  const generatedFillSecret = {
    id: 'fill-password',
    kind: 'action',
    action: 'fill-secret',
    target: TARGET,
    secretRef: '{{secrets.app.password}}',
    citation: '@ambercast-secret {{secrets.app.password}}',
  };

  const generatedAi = {
    id: 'complete-sign-in',
    kind: 'ai',
    instruction: 'Complete sign-in.',
    secrets: [{
      ref: '{{secrets.app.password}}',
      citation: '@ambercast-secret {{secrets.app.password}}',
    }],
  };

  it('accepts citation-bearing generated secret steps through every provider schema', () => {
    expectAccepted(GeneratedFillSecretAction, generatedFillSecret);
    expectAccepted(GeneratedStep, generatedFillSecret);
    expectAccepted(GeneratedAiStep, generatedAi);
    expectAccepted(GeneratedStep, generatedAi);
    expectAccepted(GeneratedPlanResponse, { steps: [generatedFillSecret, generatedAi], ambiguities: [] });
  });

  it('rejects committed source spans in provider output and citations in committed plans', () => {
    expectRejected(GeneratedFillSecretAction, { ...generatedFillSecret, secretGrantSpan: { startLine: 4, endLine: 4 } });
    expectRejected(GeneratedFillSecretAction, {
      ...generatedFillSecret,
      citation: undefined,
      secretGrantSpan: { startLine: 4, endLine: 4 },
    });
    expectRejected(GeneratedAiStep, {
      ...generatedAi,
      secrets: [{ ref: '{{secrets.app.password}}', sourceSpan: { startLine: 4, endLine: 4 } }],
    });
    expectRejected(FillSecretAction, { ...generatedFillSecret });
    expectRejected(AiStep, generatedAi);
  });

  it('enforces non-empty bounded citations', () => {
    expectRejected(GeneratedFillSecretAction, { ...generatedFillSecret, citation: '' });
    expectRejected(GeneratedFillSecretAction, { ...generatedFillSecret, citation: 'x'.repeat(4097) });
  });

  it('keeps zod and generated JSON Schema aligned for committed and provider secret shapes', () => {
    const committedPlan = plan([{
      id: 'fill-password',
      kind: 'action',
      action: 'fill-secret',
      target: TARGET,
      secretRef: '{{secrets.app.password}}',
      secretGrantSpan: { startLine: 4, endLine: 4 },
    }, {
      id: 'complete-sign-in',
      kind: 'ai',
      instruction: 'Complete sign-in.',
      secrets: [
        { ref: '{{secrets.app.password}}', sourceSpan: { startLine: 6, endLine: 6 } },
        { ref: '{{secrets.app.password}}', sourceSpan: { startLine: 8, endLine: 8 } },
      ],
    }]);

    expectZodAndJsonSchemaVerdict(PlanDocument, committedPlan, true);
    expectZodAndJsonSchemaVerdict(PlanDocument, plan([{
      id: 'fill-password',
      kind: 'action',
      action: 'fill-secret',
      target: TARGET,
      secretRef: '{{secrets.app.password}}',
    }]), false);
    expectZodAndJsonSchemaVerdict(GeneratedPlanResponse, { steps: [generatedFillSecret, generatedAi], ambiguities: [] }, true);
    expectZodAndJsonSchemaVerdict(GeneratedPlanResponse, {
      steps: [{ ...generatedFillSecret, citation: undefined, secretGrantSpan: { startLine: 4, endLine: 4 } }],
      ambiguities: [],
    }, false);
  });
});

const traceVariants: ReadonlyArray<readonly [string, SchemaUnderTest, unknown]> = [
  ['click', TraceClick, { type: 'click', target: TARGET }],
  ['navigate', TraceNavigate, { type: 'navigate', url: 'https://example.test' }],
  ['press', TracePress, { type: 'press', target: TARGET, key: 'Tab' }],
  ['fill', TraceFill, { type: 'fill', target: TARGET, value: 'person@example.test' }],
  ['fill-secret', TraceFillSecret, { type: 'fill-secret', target: TARGET, secretRef: '{{secrets.app.password}}' }],
];

const traceAssertVariants: ReadonlyArray<readonly [string, unknown]> = [
  ['text-visible', { type: 'assert', check: 'text-visible', text: 'Welcome' }],
  ['element-visible', { type: 'assert', check: 'element-visible', target: TARGET }],
  ['text-equals', { type: 'assert', check: 'text-equals', target: TARGET, text: 'Welcome' }],
  ['url-matches', { type: 'assert', check: 'url-matches', pattern: '/dashboard$' }],
  ['element-count', { type: 'assert', check: 'element-count', target: TARGET, count: 0 }],
];

describe('TraceAction, TraceAssert, TraceEntry, and TraceRecord', () => {
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

  it('rejects unknown properties for TraceFillSecret', () => {
    expectRejected(TraceFillSecret, { type: 'fill-secret', target: TARGET, secretRef: '{{secrets.app.password}}', value: 'hunter2' });
  });

  it.each(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp'] as const)('accepts the %s TracePress key enum value', (key) => {
    expectAccepted(TracePress, { type: 'press', target: TARGET, key });
  });

  it.each(traceAssertVariants)('accepts the %s trace assertion branch', (_check, value) => {
    expectAccepted(TraceAssert, value);
  });

  it('rejects invalid trace assertion discriminants and branch-level unknown properties', () => {
    expectRejected(TraceAssert, { type: 'assert', text: 'Welcome' });
    expectRejected(TraceAssert, { type: 'assert', check: 'page-ready', text: 'Welcome' });
    expectRejected(TraceAssert, { check: 'text-visible', text: 'Welcome' });
    expectRejected(TraceAssert, { type: 'click', check: 'text-visible', text: 'Welcome' });
    expectRejected(TraceAssert, { type: 'assert', check: 'text-visible', text: 'Welcome', unexpected: true });
  });

  it.each([
    ['text-visible', { type: 'assert', check: 'text-visible' }],
    ['element-visible', { type: 'assert', check: 'element-visible' }],
    ['text-equals', { type: 'assert', check: 'text-equals', target: TARGET }],
    ['url-matches', { type: 'assert', check: 'url-matches' }],
    ['element-count', { type: 'assert', check: 'element-count', target: TARGET, count: -1 }],
  ] as const)('rejects an invalid %s trace assertion branch', (_check, value) => {
    expectRejected(TraceAssert, value);
  });

  it('rejects secret markers in trace assertion text and patterns while allowing run interpolation', () => {
    expectAccepted(TraceAssert, { type: 'assert', check: 'text-visible', text: 'Welcome, {{run.username}}' });
    expectAccepted(TraceAssert, { type: 'assert', check: 'text-equals', target: TARGET, text: 'Hello {{run.username}}' });
    expectAccepted(TraceAssert, { type: 'assert', check: 'url-matches', pattern: '/{{run.path}}$' });

    expectRejected(TraceAssert, { type: 'assert', check: 'text-visible', text: 'Welcome {{secrets.app.password}}' });
    expectRejected(TraceAssert, { type: 'assert', check: 'text-equals', target: TARGET, text: '{{secrets.app.password}}' });
    expectRejected(TraceAssert, { type: 'assert', check: 'url-matches', pattern: '{{secrets.app.password}}$' });
  });

  it('rejects a trace assertion whose check and field bundle disagree', () => {
    expectRejected(TraceAssert, { type: 'assert', check: 'text-visible', target: TARGET });
  });

  it('discriminates action and assertion trace entries while rejecting type/check mismatches', () => {
    expectAccepted(TraceEntry, traceVariants[0]![2]);
    expectAccepted(TraceEntry, traceAssertVariants[0]![1]);
    expectRejected(TraceEntry, { type: 'click', check: 'text-visible', text: 'Welcome' });
  });

  it('enforces the trace-record four-quadrant rule', () => {
    const verification = { type: 'assert', check: 'text-visible', text: 'Welcome' };

    expectAccepted(TraceRecord, { events: [], verification: [verification] });
    expectRejected(TraceRecord, { events: [{ type: 'click', target: TARGET }], verification: [] });
    expectRejected(TraceRecord, { events: [], verification: [] });
    expectRejected(TraceRecord, { events: [], verification: [verification], unexpected: true });
  });

  it('allows action and assertion entries in events while requiring assertions in verification', () => {
    const action = { type: 'click', target: TARGET };
    const assertion = { type: 'assert', check: 'text-visible', text: 'Welcome' };

    expectAccepted(TraceRecord, { events: [action, assertion], verification: [assertion] });
    expectRejected(TraceRecord, { events: [action], verification: [action] });
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

  it('accepts JSON-only generator metadata recursively', () => {
    expectAccepted(PlanDocument, {
      ...plan([]),
      generatorMeta: { model: 'generator', attempt: 1, values: [true, null, { nested: 'value' }] },
    });
  });

  it('rejects the retired compilerMeta field as an unrecognized property', () => {
    expectRejected(PlanDocument, { ...plan([]), compilerMeta: { model: 'generator' } });
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
    expectRejected(PlanDocument, { ...plan([]), generatorMeta: { unsupported: undefined } });
    expectRejected(PlanDocument, { ...plan([]), unexpected: true });
    expectRejected(PlanDocument, plan([], { app: { ...TARGET_DEFINITION, unexpected: true } }));
  });
});

describe('GroundingDocument', () => {
  // Fresh generation creates an empty grounding artifact alongside its plan. The
  // element and AI entry shapes stay distinct, so each needs direct positive
  // coverage rather than relying on digest.test.ts's createGrounding() helper.
  it('accepts an element grounding entry with a fingerprint', () => {
    expectAccepted(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        'login-flow': {
          kind: 'element',
          fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A },
        },
      },
    });
  });

  it('accepts an empty entries record for a freshly generated cold-grounding artifact', () => {
    expectAccepted(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {},
    });
  });

  it('accepts an AI grounding entry with a populated trace', () => {
    expectAccepted(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        'login-flow': {
          kind: 'ai',
          trace: {
            events: traceVariants.map(([, , value]) => value),
            verification: [{ type: 'assert', check: 'text-visible', text: 'Login form is visible' }],
          },
        },
      },
    });
  });

  it('accepts a document with mixed element and AI grounding entries', () => {
    expectAccepted(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        'login-flow': {
          kind: 'element',
          fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A },
        },
        'submit-review': {
          kind: 'ai',
          trace: {
            events: [{ type: 'click', target: TARGET }],
            verification: [{ type: 'assert', check: 'element-visible', target: TARGET }],
          },
        },
      },
    });
  });

  it('rejects wrong document fields, invalid entry keys, and unknown properties', () => {
    expectRejected(GroundingDocument, { schemaVersion: 1, planDigest: 'b'.repeat(63), entries: {} });
    expectRejected(GroundingDocument, { schemaVersion: 1, planDigest: DIGEST_B, entries: { '1': { kind: 'element', fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A } } } });
    expectRejected(GroundingDocument, { schemaVersion: 1, planDigest: DIGEST_B, entries: {}, unexpected: true });
    expectRejected(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        step: { kind: 'element', fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A }, unexpected: true },
      },
    });
  });

  it('rejects a grounding entry without a kind', () => {
    expectRejected(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        step: { fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A } },
      },
    });
  });

  it('rejects a grounding entry with an unknown kind', () => {
    expectRejected(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        step: { kind: 'widget' },
      },
    });
  });

  it('rejects an element grounding entry with a trace', () => {
    expectRejected(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        step: {
          kind: 'element',
          fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A },
          trace: [{ type: 'click', target: TARGET }],
        },
      },
    });
  });

  it('rejects an AI grounding entry with a fingerprint', () => {
    expectRejected(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        step: {
          kind: 'ai',
          fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: DIGEST_A },
          trace: {
            events: [{ type: 'click', target: TARGET }],
            verification: [{ type: 'assert', check: 'text-visible', text: 'Ready' }],
          },
        },
      },
    });
  });

  it('rejects an element grounding entry without a fingerprint', () => {
    expectRejected(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        step: { kind: 'element' },
      },
    });
  });

  it('rejects an AI grounding entry without a trace', () => {
    expectRejected(GroundingDocument, {
      schemaVersion: 1,
      planDigest: DIGEST_B,
      entries: {
        step: { kind: 'ai' },
      },
    });
  });
});
