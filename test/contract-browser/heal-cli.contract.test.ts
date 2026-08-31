import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { planProducerBundleFingerprint } from '#core/ai/plan-producer-bundle.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import { GroundingDocument, PlanDocument, type JsonValueT, type TargetDefinition } from '#core/ir/schema.js';
import { ReportEnvelope } from '#report/schema.js';
import { createCodexSentinel } from './support/codex-sentinel.js';
import { resolveChromiumAvailability } from './support/chromium-availability.js';
import { createCleanupRegistry } from './support/cleanup-registry.js';
import { spawnSupervisedCli } from './support/supervised-cli.js';

const PROMPT = '# Heal confirmation fixture\n';
const CONFIRMATION_MESSAGE = 'Healing requires --yes when confirmation cannot be shown.';

let chromiumAvailable = false;

async function listen(server: Server): Promise<number> {
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
    throw new Error('The heal confirmation fixture server did not expose a TCP address.');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}


describe('heal confirmation gate through the built CLI', () => {
  beforeAll(async () => {
    if (process.platform === 'win32') {
      return;
    }
    chromiumAvailable = await resolveChromiumAvailability(() => chromium.launch());
  });

  beforeEach((context) => {
    if (process.platform === 'win32') {
      context.skip('This POSIX-only contract uses a PATH shebang sentinel and process-group termination.');
    }
    if (!chromiumAvailable) {
      context.skip('Chromium is unavailable for this opt-in contract lane; run `npx playwright install chromium` once.');
    }
  });

  it('refuses a non-interactive heal after one real re-grounding dispatch without persisting it', async () => {
    const registry = createCleanupRegistry();
    await registry.run(async () => {
      let pageRequests = 0;
      const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/') {
          pageRequests += 1;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html lang="en"><body><main><button>Submit</button></main></body></html>');
      });
      registry.deferResource(() => closeServer(server));
      const port = await listen(server);

      const project = await mkdtemp(join(tmpdir(), 'ambercast-heal-confirmation-'));
      registry.deferResource(() => rm(project, { recursive: true, force: true }));
      const tests = join(project, 'tests');
      await mkdir(tests);
      const targetDefinitions = {
        fixture: { baseUrl: `http://127.0.0.1:${port}`, browser: 'chromium' },
      } as const satisfies Record<string, TargetDefinition>;
      const plan = PlanDocument.parse({
        schemaVersion: 2,
        source: {
          inputsDigest: computeInputsDigest({
            normalizedTestMd: normalizeTestMd(PROMPT), schemaVersion: 2,
            generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
            planProducerBundleFingerprint: planProducerBundleFingerprint(), targetDefinitions,
          }),
        },
        targets: targetDefinitions,
        steps: [
          { id: 'go-to-fixture', kind: 'action', action: 'navigate', url: '/' },
          { id: 'click-submit', kind: 'action', action: 'click', target: { strategy: 'accessibility', role: 'button', name: 'Submit' } },
        ],
      });
      const grounding = GroundingDocument.parse({
        schemaVersion: 1,
        planDigest: computePlanDigest(plan),
        entries: {
          'click-submit': { kind: 'element', fingerprint: { algorithm: 'a11y-neighborhood-v2', hash: '0'.repeat(64) } },
        },
      });
      const planPath = join(tests, 'heal-confirmation.ambercast.plan.json');
      const groundingPath = join(tests, 'heal-confirmation.ambercast.grounding.json');
      await Promise.all([
        writeFile(join(project, 'ambercast.config.json'), JSON.stringify({
          $schema: 'https://ambercast.dev/schema/config.json', testDir: 'tests', runsDir: 'tests/.runs',
          targets: { fixture: { ...targetDefinitions.fixture, healReplayIsolation: 'idempotent' } },
          defaultTarget: 'fixture', ai: { provider: 'codex' }, ci: { heal: true },
        })),
        writeFile(join(tests, 'heal-confirmation.test.md'), PROMPT),
        writeFile(planPath, toCanonicalArtifactText(plan as unknown as JsonValueT)),
        writeFile(groundingPath, toCanonicalArtifactText(grounding as unknown as JsonValueT)),
      ]);
      const sentinel = await createCodexSentinel();
      registry.deferResource(() => sentinel.cleanup());
      const beforePlan = await readFile(planPath);
      const beforeGrounding = await readFile(groundingPath);
      const invocation = spawnSupervisedCli(['heal', '--json'], project, {
        ...process.env, PATH: `${sentinel.pathEntry}:${process.env.PATH ?? ''}`, CI: 'true',
      });
      registry.registerSupervisor(invocation);
      const result = await invocation.result;
      await invocation.terminateAndConfirm();
      const [afterPlan, afterGrounding, invocations] = await Promise.all([
        readFile(planPath), readFile(groundingPath), sentinel.invocations(),
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.signalCode).toBeNull();
      expect(invocation.terminated()).toBe(true);
      expect(result.stderr.toString('utf8')).toBe('');
      const envelope = JSON.parse(result.stdout.toString('utf8')) as unknown;
      expect(ReportEnvelope.safeParse(envelope).success).toBe(true);
      expect((envelope as { errors: unknown[] }).errors).toHaveLength(1);
      expect(envelope).toMatchObject({
        command: 'heal', errors: [{ scope: 'run', code: 'CONFIG_INVALID', message: CONFIRMATION_MESSAGE }],
      });
      expect(Buffer.compare(beforePlan, afterPlan)).toBe(0);
      expect(Buffer.compare(beforeGrounding, afterGrounding)).toBe(0);
      expect(invocations.filter((argv) => argv[0] === 'exec')).toHaveLength(1);
      expect(invocations.filter((argv) => argv[0] === '--version')).toHaveLength(0);
      expect(pageRequests).toBeGreaterThanOrEqual(2);
    });
  }, 90_000);
});
