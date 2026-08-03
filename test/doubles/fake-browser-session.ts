import type { ElementRef, Fingerprint } from '../../src/core/ir/schema.js';
import type {
  AssertCheck,
  AssertOutcome,
  BrowserSession,
  CaptureMode,
  PageSnapshot,
  PerformableAction,
} from '../../src/ports/browser.js';

export interface FakeBrowserSessionEntry {
  readonly currentFingerprint: Fingerprint;
  readonly exists: boolean;
}

export interface FakeBrowserSessionOptions {
  readonly captureValues?: ReadonlyMap<string, { readonly text: string; readonly value: string }>;
  readonly assertOutcome?: AssertOutcome;
  readonly snapshot?: PageSnapshot;
  readonly onPerform?: (action: PerformableAction) => void;
  readonly onEvaluateAssert?: (check: AssertCheck) => void;
  readonly onClose?: () => void;
}

export function elementRefKey(_ref: ElementRef): string {
  throw new Error('not implemented');
}

export function fingerprintsEqual(_left: Fingerprint, _right: Fingerprint): boolean {
  throw new Error('not implemented');
}

export function createFakeBrowserSession(
  _entries: ReadonlyMap<string, FakeBrowserSessionEntry>,
  _options: FakeBrowserSessionOptions = {},
): BrowserSession {
  return {
    async perform(_action): Promise<void> {
      throw new Error('not implemented');
    },
    async evaluateAssert(_check): Promise<AssertOutcome> {
      throw new Error('not implemented');
    },
    async captureValue(_target: ElementRef, _mode: CaptureMode): Promise<string> {
      throw new Error('not implemented');
    },
    async resolveGrounded(_ref: ElementRef, _fp: Fingerprint) {
      throw new Error('not implemented');
    },
    async snapshotForResolution(): Promise<PageSnapshot> {
      throw new Error('not implemented');
    },
    async screenshot(): Promise<Uint8Array> {
      throw new Error('not implemented');
    },
    async accessibilitySnapshot() {
      throw new Error('not implemented');
    },
    async close(): Promise<void> {
      throw new Error('not implemented');
    },
  };
}
