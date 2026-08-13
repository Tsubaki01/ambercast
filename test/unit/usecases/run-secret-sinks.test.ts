import { access, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCodexCliExecutor } from '#adapters/ai/codex-cli/index.js';
import { createSpawnCommandRunner } from '#adapters/ai/shared/command-runner.js';
import { typedJsonSchema } from '#core/ai/typed-json-schema.js';
import { promptTemplateFingerprint } from '#core/ai/prompt-envelope.js';
import { IntegrityViolationError } from '#core/errors/integrity-violation-error.js';
import { computeInputsDigest, computePlanDigest } from '#core/ir/digest.js';
import { toCanonicalArtifactText } from '#core/ir/canonical-json.js';
import {
  GroundingDocument,
  type ElementRef,
  type Fingerprint,
  type JsonValueT,
  type PlanDocument,
  type Step,
} from '#core/ir/schema.js';
import { normalizeTestMd } from '#core/ir/normalize.js';
import { createLayoutResolver } from '#core/layout/resolve.js';
import type { AiExecutor } from '#ports/ai.js';
import type { BrowserSession } from '#ports/browser.js';
import type { StorageAdapter } from '#ports/storage.js';
import { generate, type GenerateDeps, type GenerateOptions } from '#usecases/generate.js';
import { run, type RunDeps, type RunOptions } from '#usecases/run.js';
import { buildRunReport } from '#usecases/run-report.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';
import { createFakeBrowserDriver } from '../../doubles/fake-browser-driver.js';
import {
  createFakeBrowserSession,
  elementRefKey,
  type FakeBrowserSessionEntry,
} from '../../doubles/fake-browser-session.js';
import { createFixedClock } from '../../doubles/create-fixed-clock.js';
import { createInMemoryStorage } from '../../doubles/create-in-memory-storage.js';
import { createFakeSecretsProvider } from '../../doubles/fake-secrets-provider.js';
import { createRecordingEventSink } from '../../doubles/create-recording-event-sink.js';
import { createFakeCommandRunner } from '../../doubles/create-fake-command-runner.js';

const TEST_DIR = '/workspace/tests';
const RUNS_DIR = '/workspace/tests/.runs';
const TARGETS = { web: { baseUrl: 'https://example.test', browser: 'chromium' } } as const;
const PROMPT = '# Sign in\n\nWhen I submit valid credentials, I reach the dashboard.\n';
const SECRET_REF = '{{secrets.AMBERCAST_SECRET_DUMMY}}';
const SECRET_VALUE = 'sk-AMBERCAST_SECRET_DUMMY';
const FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v1', hash: 'a'.repeat(64) };
const DIFFERENT_FINGERPRINT: Fingerprint = { algorithm: 'a11y-neighborhood-v1', hash: 'b'.repeat(64) };
const EMAIL: ElementRef = { strategy: 'accessibility', role: 'textbox', name: 'Email' };
const PASSWORD: ElementRef = { strategy: 'accessibility', role: 'textbox', name: 'Password' };
const SUBMIT: ElementRef = { strategy: 'accessibility', role: 'button', name: 'Submit' };
const RUN_OPTIONS: RunOptions = { files: [], cacheOnly: false, allowEmpty: false, list: false, stale: 'fail' };
const GENERATE_OPTIONS: GenerateOptions = {
  files: [],
  strict: false,
  force: false,
  dryRun: false,
  allowEmpty: false,
  list: false,
};

interface RecordingStorage {
  readonly storage: StorageAdapter;
  readonly writes: Array<{ readonly path: string; readonly text: string }>;
}

interface RunScenario {
  readonly deps: RunDeps;
  readonly recordingStorage: RecordingStorage;
}

function createRecordingStorage(): RecordingStorage {
  const backing = createInMemoryStorage();
  const writes: Array<{ path: string; text: string }> = [];

  return {
    writes,
    storage: {
      ...backing,
      async writeText(path, text) {
        writes.push({ path, text });
        return backing.writeText(path, text);
      },
    },
  };
}

function liveEntries(
  refs: readonly ElementRef[],
  currentFingerprint: Fingerprint = FINGERPRINT,
): Map<string, FakeBrowserSessionEntry> {
  return new Map(refs.map((ref) => [elementRefKey(ref), { exists: true, currentFingerprint }]));
}

function elementGrounding(stepIds: readonly string[]): GroundingDocument['entries'] {
  return Object.fromEntries(stepIds.map((id) => [id, { kind: 'element', fingerprint: FINGERPRINT }])) as GroundingDocument['entries'];
}

async function writePrompt(storage: StorageAdapter, contents = PROMPT): Promise<string> {
  const path = `${TEST_DIR}/login.test.md`;
  await storage.writeText(path, contents);
  return path;
}

async function createFreshPlan(
  storage: StorageAdapter,
  testPath: string,
  steps: readonly Step[],
): Promise<PlanDocument> {
  const normalizedTestMd = normalizeTestMd(await storage.readText(testPath));
  const inputsDigest = computeInputsDigest({
    normalizedTestMd,
    schemaVersion: 1,
    generatorPromptTemplateFingerprint: promptTemplateFingerprint(),
    targetDefinitions: TARGETS,
  });
  const plan: PlanDocument = {
    schemaVersion: 1,
    source: { inputsDigest },
    targets: TARGETS,
    steps: [...steps],
  };
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  await storage.writeText(layout.planPathFor(testPath), toCanonicalArtifactText(plan as unknown as JsonValueT));
  return plan;
}

async function seedFreshArtifacts(
  storage: StorageAdapter,
  testPath: string,
  steps: readonly Step[],
  entries: GroundingDocument['entries'] = {},
): Promise<void> {
  const plan = await createFreshPlan(storage, testPath, steps);
  const layout = createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR });
  const grounding: GroundingDocument = {
    schemaVersion: 1,
    planDigest: computePlanDigest(plan),
    entries,
  };
  await storage.writeText(layout.groundingPathFor(testPath), toCanonicalArtifactText(grounding as unknown as JsonValueT));
}

function aiStep(): Extract<Step, { kind: 'ai' }> {
  return {
    id: 'recorded-ai',
    kind: 'ai',
    instruction: 'Complete the sign-in flow and verify the dashboard.',
    secrets: [SECRET_REF],
  };
}

function createRunScenario(
  session: BrowserSession,
  executor: AiExecutor,
  secrets: ReadonlyMap<string, string> = new Map(),
): RunScenario {
  const recordingStorage = createRecordingStorage();
  const events = createRecordingEventSink();
  return {
    recordingStorage,
    deps: {
      storage: recordingStorage.storage,
      layout: createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }),
      clock: createFixedClock(new Date('2026-08-10T00:00:00.000Z'), 0),
      runId: '2026-08-10T000000Z-550e8400-e29b-41d4-a716-446655440000',
      browserDriver: vi.fn(() => createFakeBrowserDriver(() => session)),
      secrets: createFakeSecretsProvider(secrets),
      resolveAiExecutor: async () => executor,
      events: events.sink,
      discoverTestFiles: async () => ['login.test.md'],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: 120_000 },
      },
    },
  };
}

function createGenerateScenario(
  aiExecutor: AiExecutor,
  aiTimeoutMs = 100,
): { readonly deps: GenerateDeps; readonly recordingStorage: RecordingStorage } {
  const recordingStorage = createRecordingStorage();
  return {
    recordingStorage,
    deps: {
      storage: recordingStorage.storage,
      layout: createLayoutResolver({ testDir: TEST_DIR, runsDir: RUNS_DIR }),
      aiExecutor,
      events: createRecordingEventSink().sink,
      discoverTestFiles: async () => ['login.test.md'],
      config: {
        testDir: TEST_DIR,
        testMatch: ['**/*.test.md'],
        testIgnore: ['**/.runs/**'],
        targets: TARGETS,
        defaultTarget: 'web',
        ai: { provider: 'codex', timeoutMs: aiTimeoutMs },
      },
    },
  };
}

function commandPaths(args: readonly string[]): { readonly schemaPath: string; readonly outputPath: string } {
  const schemaIndex = args.indexOf('--output-schema');
  const outputIndex = args.indexOf('-o');
  const schemaPath = args[schemaIndex + 1];
  const outputPath = args[outputIndex + 1];
  if (schemaPath === undefined || outputPath === undefined) {
    throw new Error('Codex schema and output paths must be present.');
  }

  return { schemaPath, outputPath };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('run secret sinks', () => {
  it('keeps AMBERCAST_SECRET_DUMMY out of the prompt envelope at the real Codex adapter boundary', async () => {
    const runner = createFakeCommandRunner([async (call) => {
      const { outputPath } = commandPaths(call.args);
      await writeFile(outputPath, '{"ok":true}');
      return { outcome: 'exited', stdout: '', stderr: '', exitCode: 0 };
    }]);
    const executor = createCodexCliExecutor({ run: runner.run });

    await expect(executor.execute({
      prompt: 'Generate a redaction-safe plan.',
      context: { sanitizedReference: SECRET_REF, page: { title: 'Sign in' } },
      responseSchema: typedJsonSchema(z.object({ ok: z.boolean() })),
    })).resolves.toMatchObject({ data: { ok: true } });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.options?.input).not.toContain(SECRET_VALUE);
  });

  it('keeps AMBERCAST_SECRET_DUMMY out of CLI arguments for structured and agentic calls', async () => {
    const runner = createFakeCommandRunner([async (call) => {
      const { outputPath } = commandPaths(call.args);
      await writeFile(outputPath, '{"ok":true}');
      return { outcome: 'exited', stdout: '', stderr: '', exitCode: 0 };
    }]);
    const executor = createCodexCliExecutor({ run: runner.run });
    const controller = {
      perform: async () => undefined,
      evaluateAssert: async () => ({ passed: true } as const),
      snapshotForResolution: async () => ({ accessibilityTree: {} }),
    };

    await executor.execute({
      prompt: 'Generate a redaction-safe plan.',
      context: { sanitizedReference: SECRET_REF },
      responseSchema: typedJsonSchema(z.object({ ok: z.boolean() })),
    });
    await expect(executor.executeAgentic({
      instructionPrompt: 'Drive the browser without materialized secrets.',
      allowedSecretRefs: [SECRET_REF],
      allowedRunRefs: [],
      controller,
    })).rejects.toMatchObject({ kind: 'ai-executor-unavailable' });

    expect(runner.calls).toHaveLength(1);
    for (const call of runner.calls) {
      expect(call.args.some((argument) => argument.includes(SECRET_VALUE))).toBe(false);
    }
  });

  it('removes AMBERCAST_SECRET_DUMMY from the spawned child environment while retaining allowed variables', async () => {
    vi.stubEnv('AMBERCAST_SECRET_DUMMY', SECRET_VALUE);
    vi.stubEnv('AMBERCAST_TEST_ALLOWED', '1');
    const runner = createSpawnCommandRunner({ env: process.env });
    const result = await runner(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))']);

    expect(result).toMatchObject({ outcome: 'exited', exitCode: 0 });
    if (result.outcome !== 'exited') {
      throw new Error('Expected the environment probe child to exit normally.');
    }
    const childEnvironment = JSON.parse(result.stdout) as NodeJS.ProcessEnv;
    expect(childEnvironment).not.toHaveProperty('AMBERCAST_SECRET_DUMMY');
    expect(childEnvironment.AMBERCAST_TEST_ALLOWED).toBe('1');
    expect(childEnvironment.PATH).toBe(process.env.PATH);
    expect(childEnvironment.HOME).toBe(process.env.HOME);
  });

  it('rejects the c4 in-flow grounding leak before a write can be attempted', async () => {
    const session = createFakeBrowserSession(liveEntries([PASSWORD]));
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef: SECRET_REF });
        await request.controller.evaluateAssert({
          type: 'assert',
          check: 'text-visible',
          text: `Welcome back, token=${SECRET_VALUE}!`,
        });
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createRunScenario(session, executor, new Map([[SECRET_REF, SECRET_VALUE]]));
    const testPath = await writePrompt(recordingStorage.storage, `${PROMPT}\n${SECRET_REF}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, RUN_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(recordingStorage.writes).toEqual([]);
    expect(session.operations()).toEqual([
      { type: 'perform', action: { type: 'fill-secret', target: PASSWORD, value: SECRET_VALUE } },
    ]);
  });

  it('refuses the grounding write for an AI target name that bypasses the in-flow switch', async () => {
    const unsafeTarget: ElementRef = {
      strategy: 'accessibility',
      role: 'button',
      name: `Continue with ${SECRET_VALUE}`,
    };
    const session = createFakeBrowserSession(liveEntries([PASSWORD, unsafeTarget]));
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef: SECRET_REF });
        await request.controller.perform({ type: 'click', target: unsafeTarget });
        await request.controller.evaluateAssert({ type: 'assert', check: 'text-visible', text: 'Dashboard' });
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createRunScenario(session, executor, new Map([[SECRET_REF, SECRET_VALUE]]));
    const testPath = await writePrompt(recordingStorage.storage, `${PROMPT}\n${SECRET_REF}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, RUN_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(outcome.results[0]?.result.status).toBe('error');
    expect(recordingStorage.writes).toEqual([]);
    expect(session.operations()).toEqual([
      { type: 'perform', action: { type: 'fill-secret', target: PASSWORD, value: SECRET_VALUE } },
      { type: 'perform', action: { type: 'click', target: unsafeTarget } },
      { type: 'evaluate-assert', check: { check: 'text-visible', text: 'Dashboard' } },
    ]);
  });

  it('surfaces a dirty grounding integrity violation over a later deterministic assertion failure', async () => {
    const unsafeTarget: ElementRef = {
      strategy: 'accessibility',
      role: 'button',
      name: `Continue with ${SECRET_VALUE}`,
    };
    const session = createFakeBrowserSession(liveEntries([PASSWORD, SUBMIT, unsafeTarget]), {
      assertOutcomes: [
        { passed: true },
        { passed: false, message: 'The dashboard was not visible.' },
      ],
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef: SECRET_REF });
        await request.controller.perform({ type: 'click', target: unsafeTarget });
        await request.controller.evaluateAssert({ type: 'assert', check: 'text-visible', text: 'Dashboard' });
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createRunScenario(session, executor, new Map([[SECRET_REF, SECRET_VALUE]]));
    const testPath = await writePrompt(recordingStorage.storage, `${PROMPT}\n${SECRET_REF}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [
      aiStep(),
      { id: 'later-ordinary-assertion', kind: 'assert', check: 'element-visible', target: SUBMIT },
    ], elementGrounding(['later-ordinary-assertion']));
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, RUN_OPTIONS);

    expect(outcome.results[0]?.error).toBeInstanceOf(IntegrityViolationError);
    expect(outcome.results[0]?.result).toMatchObject({
      status: 'error',
      explanation: 'The grounding cache contains a materialized secret value.',
      steps: [
        { id: 'recorded-ai', status: 'passed' },
        { id: 'later-ordinary-assertion', status: 'failed', kind: 'assertion' },
      ],
    });
    expect(recordingStorage.writes).toEqual([]);
  });

  it('persists grounding when only an authored step ID contains a resolved secret substring', async () => {
    const secretValue = 'authored-secret';
    const authoredStepId = `recorded-${secretValue}`;
    const session = createFakeBrowserSession(liveEntries([PASSWORD]));
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef: SECRET_REF });
        await request.controller.evaluateAssert({ type: 'assert', check: 'text-visible', text: 'Dashboard' });
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createRunScenario(session, executor, new Map([[SECRET_REF, secretValue]]));
    const testPath = await writePrompt(recordingStorage.storage, `${PROMPT}\n${SECRET_REF}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [{
      id: authoredStepId,
      kind: 'ai',
      instruction: 'Complete the sign-in flow and verify the dashboard.',
      secrets: [SECRET_REF],
    }]);
    recordingStorage.writes.length = 0;

    const outcome = await run(deps, RUN_OPTIONS);

    expect(outcome.results[0]?.error).toBeUndefined();
    expect(outcome.results[0]?.result.status).toBe('passed');
    expect(recordingStorage.writes).toHaveLength(1);
  });

  it('rejects a generated plan that smuggles AMBERCAST_SECRET_DUMMY as a literal', async () => {
    const response = {
      steps: [{
        id: 'fill-token',
        kind: 'action',
        action: 'fill',
        target: PASSWORD,
        value: SECRET_VALUE,
      }],
      ambiguities: [],
    };
    const executor = createFakeAiExecutor({
      execute: async () => ({ data: response, raw: JSON.stringify(response) }),
    });
    const { deps, recordingStorage } = createGenerateScenario(executor);
    await writePrompt(recordingStorage.storage);
    recordingStorage.writes.length = 0;

    const outcome = await generate(deps, GENERATE_OPTIONS);

    expect(outcome.results[0]).toMatchObject({
      status: 'failed',
      error: { kind: 'secret-literal-rejected' },
    });
    expect(recordingStorage.writes).toEqual([]);
  });

  it('keeps AMBERCAST_SECRET_DUMMY out of rendered failed and classified-exception reports', async () => {
    const failedSession = createFakeBrowserSession(liveEntries([PASSWORD]), {
      assertOutcome: { passed: false, message: `Expected text contained ${SECRET_VALUE}.` },
    });
    const failedScenario = createRunScenario(failedSession, createFakeAiExecutor(), new Map([[SECRET_REF, SECRET_VALUE]]));
    const failedPath = await writePrompt(failedScenario.recordingStorage.storage, `${PROMPT}\n${SECRET_REF}\n`);
    await seedFreshArtifacts(failedScenario.recordingStorage.storage, failedPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef: SECRET_REF },
      { id: 'secret-assertion', kind: 'assert', check: 'text-equals', target: PASSWORD, text: 'Dashboard' },
    ], elementGrounding(['fill-secret', 'secret-assertion']));
    const failedOutcome = await run(failedScenario.deps, RUN_OPTIONS);

    const exceptionSession = createFakeBrowserSession(liveEntries([PASSWORD]), {
      onPerform(action) {
        if (action.type === 'navigate') {
          throw new IntegrityViolationError(`Navigation diagnostic contains ${SECRET_VALUE}.`, { secret: SECRET_VALUE });
        }
      },
    });
    const exceptionScenario = createRunScenario(exceptionSession, createFakeAiExecutor(), new Map([[SECRET_REF, SECRET_VALUE]]));
    const exceptionPath = await writePrompt(exceptionScenario.recordingStorage.storage, `${PROMPT}\n${SECRET_REF}\n`);
    await seedFreshArtifacts(exceptionScenario.recordingStorage.storage, exceptionPath, [
      { id: 'fill-secret', kind: 'action', action: 'fill-secret', target: PASSWORD, secretRef: SECRET_REF },
      { id: 'go-dashboard', kind: 'action', action: 'navigate', url: '/dashboard' },
    ], elementGrounding(['fill-secret']));
    const exceptionOutcome = await run(exceptionScenario.deps, RUN_OPTIONS);

    for (const outcome of [failedOutcome, exceptionOutcome]) {
      const report = buildRunReport({
        startedAt: '2026-08-10T00:00:00.000Z',
        durationMs: 0,
        options: { allowEmpty: false, list: false },
        outcome,
      });
      expect(JSON.stringify(report)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(report)).toContain(SECRET_REF);
    }
  });

  it('redacts AMBERCAST_SECRET_DUMMY from a browser exception before it reaches the case result', async () => {
    const session = createFakeBrowserSession(liveEntries([EMAIL, PASSWORD]), {
      onPerform(action) {
        if (action.type === 'fill') {
          throw new IntegrityViolationError(`Browser action retained ${SECRET_VALUE}.`, { secret: SECRET_VALUE });
        }
      },
    });
    const executor = createFakeAiExecutor({
      async executeAgentic(request) {
        await request.controller.perform({ type: 'fill-secret', target: PASSWORD, secretRef: SECRET_REF });
        await request.controller.perform({ type: 'fill', target: EMAIL, value: 'ordinary provider value' });
        return { outcome: 'success' };
      },
    });
    const { deps, recordingStorage } = createRunScenario(session, executor, new Map([[SECRET_REF, SECRET_VALUE]]));
    const testPath = await writePrompt(recordingStorage.storage, `${PROMPT}\n${SECRET_REF}\n`);
    await seedFreshArtifacts(recordingStorage.storage, testPath, [aiStep()]);

    const outcome = await run(deps, RUN_OPTIONS);
    const error = outcome.results[0]?.error;

    expect(error).toBeInstanceOf(IntegrityViolationError);
    expect(error?.message).toContain(SECRET_REF);
    expect(error?.message).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(outcome.results[0])).not.toContain(SECRET_VALUE);
  });

  it('keeps AMBERCAST_SECRET_DUMMY out of real production schemas and removes both Codex temp directories', async () => {
    let generatedPlanSchemaPath = '';
    let generatedPlanSchema = '';
    const generateRunner = createFakeCommandRunner([async (call) => {
      const { schemaPath, outputPath } = commandPaths(call.args);
      generatedPlanSchemaPath = schemaPath;
      generatedPlanSchema = await readFile(schemaPath, 'utf8');
      await writeFile(outputPath, '{"steps":[],"ambiguities":[]}');
      return { outcome: 'exited', stdout: '', stderr: '', exitCode: 0 };
    }]);
    const generateExecutor = createCodexCliExecutor({ run: generateRunner.run });
    // This sink exercises the real adapter's filesystem I/O, unlike the fake-executor cases above.
    const generateScenario = createGenerateScenario(generateExecutor, 5_000);
    await writePrompt(generateScenario.recordingStorage.storage);

    await expect(generate(generateScenario.deps, GENERATE_OPTIONS)).resolves.toMatchObject({
      results: [{ status: 'generated' }],
    });

    let fingerprintSchemaPath = '';
    let fingerprintSchema = '';
    const runRunner = createFakeCommandRunner([async (call) => {
      const { schemaPath, outputPath } = commandPaths(call.args);
      fingerprintSchemaPath = schemaPath;
      fingerprintSchema = await readFile(schemaPath, 'utf8');
      await writeFile(outputPath, JSON.stringify({ confirmed: true }));
      return { outcome: 'exited', stdout: '', stderr: '', exitCode: 0 };
    }]);
    const runExecutor = createCodexCliExecutor({ run: runRunner.run });
    const session = createFakeBrowserSession(liveEntries([SUBMIT], DIFFERENT_FINGERPRINT), {
      snapshot: {
        accessibilityTree: {
          role: 'root',
          name: '',
          children: [{
            role: 'form',
            name: 'Sign in',
            children: [
              { role: 'textbox', name: 'Email', children: [] },
              { role: 'button', name: 'Submit', children: [] },
            ],
          }],
        },
        screenshot: new Uint8Array(),
      },
    });
    const runScenario = createRunScenario(session, runExecutor);
    const testPath = await writePrompt(runScenario.recordingStorage.storage);
    await seedFreshArtifacts(
      runScenario.recordingStorage.storage,
      testPath,
      [{ id: 'click-submit', kind: 'action', action: 'click', target: SUBMIT }],
      elementGrounding(['click-submit']),
    );

    await expect(run(runScenario.deps, RUN_OPTIONS)).resolves.toMatchObject({
      results: [{ result: { status: 'passed' } }],
    });

    for (const [schemaPath, schemaContents] of [
      [generatedPlanSchemaPath, generatedPlanSchema],
      [fingerprintSchemaPath, fingerprintSchema],
    ] as const) {
      expect(schemaContents).not.toBe('');
      expect(schemaContents).not.toContain(SECRET_VALUE);
      await expect(access(dirname(schemaPath))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
