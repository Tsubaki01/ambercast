import { describe, expectTypeOf, it } from 'vitest';
import type { ElementRef, Fingerprint, JsonValueT, TargetDefinition } from '../../../src/core/ir/schema.js';
import type {
  AssertCheck,
  AssertOutcome,
  BrowserDriver,
  BrowserEngine,
  BrowserSession,
  CaptureMode,
  GroundedResolution,
  PageSnapshot,
  PerformableAction,
} from '../../../src/ports/browser.js';

// Optionality probe: {} is assignable to Pick<BrowserSession, 'resolveGrounded'> exactly when nothing in that pick is required.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type ResolveGroundedIsRequired = {} extends Pick<BrowserSession, 'resolveGrounded'> ? true : false;

describe('browser port shapes', () => {
  it('defines the materialized action, assertion, evidence, and grounding shapes', () => {
    expectTypeOf<BrowserEngine>().toEqualTypeOf<TargetDefinition['browser']>();
    expectTypeOf<PageSnapshot>().toEqualTypeOf<{
      readonly accessibilityTree: JsonValueT;
      readonly screenshot: Uint8Array;
    }>();
    expectTypeOf<PerformableAction>().toEqualTypeOf<
      | { readonly type: 'click'; readonly target: ElementRef }
      | { readonly type: 'navigate'; readonly url: string }
      | { readonly type: 'press'; readonly target: ElementRef; readonly key: 'Enter' | 'Tab' | 'Escape' | 'ArrowDown' | 'ArrowUp' }
      | { readonly type: 'fill'; readonly target: ElementRef; readonly value: string }
      | { readonly type: 'fill-secret'; readonly target: ElementRef; readonly value: string }
    >();
    expectTypeOf<AssertCheck>().toEqualTypeOf<
      | { readonly check: 'text-visible'; readonly text: string }
      | { readonly check: 'element-visible'; readonly target: ElementRef }
      | { readonly check: 'text-equals'; readonly target: ElementRef; readonly text: string }
      | { readonly check: 'url-matches'; readonly pattern: string }
      | { readonly check: 'element-count'; readonly target: ElementRef; readonly count: number }
    >();
    expectTypeOf<AssertOutcome>().toEqualTypeOf<
      | { readonly passed: true; readonly message?: string }
      | { readonly passed: false; readonly message: string }
    >();
    expectTypeOf<CaptureMode>().toEqualTypeOf<'text' | 'value'>();
    expectTypeOf<GroundedResolution>().toEqualTypeOf<
      | { readonly kind: 'hit'; readonly ref: ElementRef }
      | { readonly kind: 'miss'; readonly reason: 'fingerprint-mismatch' | 'element-not-found' | 'ambiguous-match' }
    >();
  });

  it('defines every browser session operation with its exact arguments', () => {
    expectTypeOf<BrowserSession['perform']>().toEqualTypeOf<(action: PerformableAction) => Promise<void>>();
    expectTypeOf<BrowserSession['evaluateAssert']>().toEqualTypeOf<(check: AssertCheck) => Promise<AssertOutcome>>();
    expectTypeOf<BrowserSession['captureValue']>().toEqualTypeOf<(target: ElementRef, mode: CaptureMode) => Promise<string>>();
    expectTypeOf<BrowserSession['resolveGrounded']>().toEqualTypeOf<
      (ref: ElementRef, fp: Fingerprint) => Promise<GroundedResolution>
    >();
    expectTypeOf<BrowserSession['snapshotForResolution']>().toEqualTypeOf<() => Promise<PageSnapshot>>();
    expectTypeOf<BrowserSession['screenshot']>().toEqualTypeOf<() => Promise<Uint8Array>>();
    expectTypeOf<BrowserSession['accessibilitySnapshot']>().toEqualTypeOf<() => Promise<JsonValueT>>();
    expectTypeOf<BrowserSession['close']>().toEqualTypeOf<() => Promise<void>>();
  });

  it('defines a driver with its selected engine and launch operation', () => {
    expectTypeOf<BrowserDriver['engine']>().toEqualTypeOf<BrowserEngine>();
    expectTypeOf<BrowserDriver['launch']>().toEqualTypeOf<(target: TargetDefinition) => Promise<BrowserSession>>();
  });

  it('keeps resolveGrounded required', () => {
    expectTypeOf<ResolveGroundedIsRequired>().toEqualTypeOf<false>();
  });
});
