import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

const binPath = fileURLToPath(new URL('../../bin/ambercast.js', import.meta.url));
const PROMPT = '# Heal confirmation fixture\n';
const CONFIRMATION_MESSAGE = 'Healing requires --yes when confirmation cannot be shown.';

type CliResult = {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
};

type CleanupTask = () => Promise<void> | void;

let chromiumAvailable = false;

/** Preserve an operation failure while still attempting every registered cleanup. */
async function runWithCleanup<T>(operation: () => Promise<T>, cleanupTasks: readonly CleanupTask[]): Promise<T> {
  const outcome = await Promise.resolve().then(operation).then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason: unknown) => ({ status: 'rejected', reason }) as const,
  );
  const cleanupFailures: unknown[] = [];
  for (const cleanup of cleanupTasks) {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (outcome.status === 'rejected') {
    if (cleanupFailures.length > 0) {
      throw new AggregateError([outcome.reason, ...cleanupFailures], 'The heal CLI operation and cleanup both failed.');
    }
    throw outcome.reason;
  }
  if (cleanupFailures.length === 1) {
    throw cleanupFailures[0];
  }
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, 'Multiple heal CLI cleanup tasks failed.');
  }
  return outcome.value;
}

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

/** Sends a signal to the detached POSIX process group, accepting an exit race. */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}

/**
 * Runs the real built CLI and resolves only once its stdio streams have closed.
 *
 * The detached process group lets the timeout escalation also target browser
 * descendants on POSIX. The test intentionally skips on Windows, where this
 * sentinel/shebang and negative-PID process-group contract is unavailable.
 */
function runCli(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): {
  readonly child: ChildProcess;
  readonly result: Promise<CliResult>;
  readonly stop: () => void;
} {
  const child = spawn(process.execPath, [binPath, ...args], {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let closed = false;
  let exited = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  const clearTimers = (): void => {
    for (const timer of [termTimer, killTimer, closeTimer]) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };
  const stop = (): void => {
    if (!closed) {
      signalProcessGroup(child, 'SIGTERM');
    }
  };
  const result = new Promise<CliResult>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      callback();
    };
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      signalCode = signal;
    });
    child.once('close', (code, signal) => {
      closed = true;
      settle(() => resolve({
        stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: exited ? exitCode : code,
        signalCode: exited ? signalCode : signal,
      }));
    });
    termTimer = setTimeout(() => {
      try {
        if (closed) {
          return;
        }
        signalProcessGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => {
          try {
            if (closed) {
              return;
            }
            signalProcessGroup(child, 'SIGKILL');
            closeTimer = setTimeout(() => {
              try {
                settle(() => reject(new Error('The heal CLI child did not exit after SIGKILL.')));
              } catch (error) {
                settle(() => reject(error));
              }
            }, 5_000);
          } catch (error) {
            settle(() => reject(error));
          }
        }, 5_000);
      } catch (error) {
        settle(() => reject(error));
      }
    }, 45_000);
  });
  return { child, result, stop };
}

async function waitForChildPidExit(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) {
    return;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('The heal CLI child PID remained live after its close event.');
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
    const cleanupTasks: CleanupTask[] = [];
    await runWithCleanup(async () => {
      let pageRequests = 0;
      const server = createServer((request, response) => {
        if (request.method === 'GET' && request.url === '/') {
          pageRequests += 1;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html lang="en"><body><main><button>Submit</button></main></body></html>');
      });
      cleanupTasks.push(() => closeServer(server));
      const port = await listen(server);

      const project = await mkdtemp(join(tmpdir(), 'ambercast-heal-confirmation-'));
      cleanupTasks.unshift(() => rm(project, { recursive: true, force: true }));
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
      cleanupTasks.splice(1, 0, () => sentinel.cleanup());
      const beforePlan = await readFile(planPath);
      const beforeGrounding = await readFile(groundingPath);
      const invocation = runCli(['heal', '--json'], project, {
        ...process.env, PATH: `${sentinel.pathEntry}:${process.env.PATH ?? ''}`, CI: 'true',
      });
      cleanupTasks.unshift(invocation.stop);
      const result = await invocation.result;
      await waitForChildPidExit(invocation.child);
      const [afterPlan, afterGrounding, invocations] = await Promise.all([
        readFile(planPath), readFile(groundingPath), sentinel.invocations(),
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.signalCode).toBeNull();
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
    }, cleanupTasks);
  }, 90_000);
});
