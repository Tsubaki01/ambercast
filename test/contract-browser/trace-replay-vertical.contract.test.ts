import { createServer } from 'node:http';
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
import { resolveChromiumAvailability } from './support/chromium-availability.js';

const TEST_DIR = '/workspace/trace-replay-contract';
const RUNS_DIR = '/workspace/trace-replay-contract/.runs';
const TEST_PATH = `${TEST_DIR}/hand-authored-trace.test.md`;
const PROMPT = '# Replay a hand-authored trace\n\nVerify the fixture is ready.\n';

const RUN_OPTIONS: RunOptions = {
  files: [TEST_PATH],
  cacheOnly: false,
  stale: 'fail',
};

let chromiumAvailable = false;

describe('hand-authored trace replay against real Chromium', () => {
  beforeAll(async () => {
    chromiumAvailable = await resolveChromiumAvailability(() => chromium.launch());
  });

  beforeEach((context) => {
    if (!chromiumAvailable) {
      context.skip('Chromium is unavailable for this opt-in contract lane; run `npx playwright install chromium` once.');
    }
  });

  it('replays a committed AI trace with zero AI calls', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Trace replay fixture ready</h1>
    </main>
  </body>
</html>`);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });

      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('The trace replay fixture server did not expose a TCP address.');
      }

      const baseUrl = `http://127.0.0.1:${address.port}`;
      const targets = {
        fixture: { baseUrl, browser: 'chromium' },
      } as const satisfies Record<string, TargetDefinition>;
      const plan = PlanDocument.parse({
        schemaVersion: 1,
        source: {
          inputsDigest: computeInputsDigest({
            normalizedTestMd: normalizeTestMd(PROMPT),
            schemaVersion: 1,
            generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
            targetDefinitions: targets,
          }),
        },
        targets,
        steps: [
          {
            id: 'verify-hand-authored-trace',
            kind: 'ai',
            instruction: 'Verify that the trace replay fixture is ready.',
          },
        ],
      });
      // This committed fixture is a trace a prior live execution recorded by
      // hand. Relative navigation keeps replay on the local fixture origin,
      // where a real browser verifies the DOM without an AI adapter.
      const grounding = GroundingDocument.parse({
        schemaVersion: 1,
        planDigest: computePlanDigest(plan),
        entries: {
          'verify-hand-authored-trace': {
            kind: 'ai',
            trace: {
              events: [{ type: 'navigate', url: '/' }],
              verification: [
                { type: 'assert', check: 'text-visible', text: 'Trace replay fixture ready' },
              ],
            },
          },
        },
      });
      const storage = createInMemoryStorage();
      const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
      const events = createRecordingEventSink();
      const resolveAiExecutor = vi.fn(async () => {
        throw new Error('Trace replay must not resolve an AI executor.');
      });
      await storage.writeText(TEST_PATH, PROMPT);
      await storage.writeText(
        layout.planPathFor(TEST_PATH),
        toCanonicalArtifactText(plan as unknown as JsonValueT),
      );
      await storage.writeText(
        layout.groundingPathFor(TEST_PATH),
        toCanonicalArtifactText(grounding as unknown as JsonValueT),
      );

      const deps: RunDeps = {
        storage,
        layout,
        clock: createFixedClock(new Date('2026-08-10T00:00:00.000Z'), 0),
        runId: '2026-08-10T000000Z-550e8400-e29b-41d4-a716-446655440000',
        browserDriver: () => createChromiumBrowserDriver(),
        secrets: createFakeSecretsProvider(new Map()),
        resolveAiExecutor,
        events: events.sink,
        discoverTestFiles: async () => [],
        config: {
          testDir: TEST_DIR,
          testMatch: ['**/*.test.md'],
          testIgnore: ['**/.runs/**'],
          targets,
          defaultTarget: 'fixture',
          ai: { provider: 'codex', timeoutMs: 120_000 },
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
    } finally {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error === undefined ? resolve() : reject(error));
        });
      }
    }
  });
});
