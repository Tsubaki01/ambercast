import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import { createChromiumBrowserDriver } from '#adapters/browser/chromium.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import {
  GroundingDocument,
  PlanDocument,
  type JsonValueT,
  type TargetDefinition,
} from '#core/ir/schema.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import { run, type RunDeps, type RunOptions } from '#usecases/run.js';
import { createFixedClock } from '../doubles/create-fixed-clock.js';
import { createInMemoryStorage } from '../doubles/create-in-memory-storage.js';
import { createRecordingEventSink } from '../doubles/create-recording-event-sink.js';
import { createFakeSecretsProvider } from '../doubles/fake-secrets-provider.js';

const TEST_DIR = '/workspace/trace-replay-contract';
const RUNS_DIR = '/workspace/trace-replay-contract/.runs';
const TEST_PATH = `${TEST_DIR}/hand-authored-trace.test.md`;
const PROMPT = '# Replay a hand-authored trace\n\nVerify the fixture is ready.\n';
const TARGETS = {
  fixture: { baseUrl: 'https://example.test', browser: 'chromium' },
} as const satisfies Record<string, TargetDefinition>;
const FIXTURE_PAGE = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Trace replay fixture ready</h1>
    </main>
  </body>
</html>`)}`;

const PLAN = PlanDocument.parse({
  schemaVersion: 1,
  source: {
    inputsDigest: computeInputsDigest({
      normalizedTestMd: normalizeTestMd(PROMPT),
      schemaVersion: 1,
      generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
      targetDefinitions: TARGETS,
    }),
  },
  targets: TARGETS,
  steps: [
    {
      id: 'verify-hand-authored-trace',
      kind: 'ai',
      instruction: 'Verify that the trace replay fixture is ready.',
    },
  ],
});

// This committed fixture is the trace a prior live execution recorded by hand
// against FIXTURE_PAGE. It deliberately requires no AI adapter at test time:
// navigation is replayed by the real browser, then verification observes its
// real DOM rather than a fake browser-session response.
const GROUNDING = GroundingDocument.parse({
  schemaVersion: 1,
  planDigest: computePlanDigest(PLAN),
  entries: {
    'verify-hand-authored-trace': {
      kind: 'ai',
      trace: {
        events: [
          { type: 'navigate', url: FIXTURE_PAGE },
        ],
        verification: [
          { type: 'assert', check: 'text-visible', text: 'Trace replay fixture ready' },
        ],
      },
    },
  },
});

const RUN_OPTIONS: RunOptions = {
  files: [TEST_PATH],
  cacheOnly: false,
  stale: 'fail',
};

let chromiumAvailable = false;

describe('hand-authored trace replay against real Chromium', () => {
  beforeAll(async () => {
    try {
      const browser = await chromium.launch();
      await browser.close();
      chromiumAvailable = true;
    } catch {
      chromiumAvailable = false;
    }
  });

  // Match the existing Chromium contract's opt-in behavior when Playwright's
  // local browser binary has not been installed.
  beforeEach((context) => {
    if (!chromiumAvailable) {
      context.skip('Chromium is unavailable for this opt-in contract lane; run `npx playwright install chromium` once.');
    }
  });

  it('replays a committed AI trace with zero AI calls', async () => {
    const storage = createInMemoryStorage();
    const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
    const events = createRecordingEventSink();
    const resolveAiExecutor = vi.fn(async () => {
      throw new Error('Trace replay must not resolve an AI executor.');
    });
    await storage.writeText(TEST_PATH, PROMPT);
    await storage.writeText(
      layout.planPathFor(TEST_PATH),
      toCanonicalArtifactText(PLAN as unknown as JsonValueT),
    );
    await storage.writeText(
      layout.groundingPathFor(TEST_PATH),
      toCanonicalArtifactText(GROUNDING as unknown as JsonValueT),
    );

    const deps: RunDeps = {
      storage,
      layout,
      clock: createFixedClock(new Date('2026-08-10T00:00:00.000Z'), 0),
      browserDriver: () => createChromiumBrowserDriver(),
      secrets: createFakeSecretsProvider(new Map()),
      resolveAiExecutor,
      events: events.sink,
      discoverTestFiles: async () => [],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'fixture',
      },
    };

    const outcome = await run(deps, RUN_OPTIONS);

    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(events.emitted().filter((event) => event.type === 'step-result')).toEqual([
      {
        type: 'step-result',
        stepId: 'verify-hand-authored-trace',
        via: 'trace-replay',
      },
    ]);
    expect(events.emitted().filter((event) => event.type === 'ai-call')).toEqual([]);
    expect(resolveAiExecutor).not.toHaveBeenCalled();
  });
});
