import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSupervised, spawnSupervisedCli, type SupervisedCli } from '../../contract-browser/support/supervised-cli.js';

const shortTimings = { sigtermAfterMs: 250, sigkillAfterMs: 30, failAfterMs: 30, pollIntervalMs: 5 };
const naturalExitTimings = { ...shortTimings, sigtermAfterMs: 5_000 };
const childScript = (source: string): readonly string[] => ['-e', source];
const waitDeadlineMs = 5_000;

function signalsSent(kill: { mock: { calls: unknown[][] } }): unknown[] {
  return kill.mock.calls.map((call) => call[1]).filter((signal) => signal !== 0);
}

async function waitForMarker(marker: string, expected: RegExp): Promise<string> {
  const deadline = Date.now() + waitDeadlineMs;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(marker, 'utf8');
      if (expected.test(contents)) return contents;
    } catch (error: unknown) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${expected} in ${marker}`);
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + waitDeadlineMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

function isGroupAlive(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false;
    throw error;
  }
}

describe('supervised process spawning', () => {
  const projects: string[] = [];
  const groupIds = new Set<number>();

  const track = <T extends SupervisedCli>(invocation: T): T => {
    if (invocation.child.pid !== undefined) groupIds.add(invocation.child.pid);
    return invocation;
  };

  beforeEach((context) => {
    if (process.platform === 'win32') {
      context.skip('This POSIX-only suite requires detached negative-PID process-group termination.');
    }
  });
  afterEach(async () => {
    for (const groupId of groupIds) {
      try {
        process.kill(-groupId, 'SIGKILL');
      } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
      }
    }
    await Promise.all([...groupIds].map((groupId) => waitFor(
      () => !isGroupAlive(groupId),
      `process group ${groupId} to exit during test cleanup`,
    )));
    groupIds.clear();
    vi.restoreAllMocks();
    await Promise.all(projects.splice(0).map((project) => rm(project, { recursive: true, force: true })));
  });

  it('returns stdout and exit code for a quick cooperative process without signaling', async () => {
    const kill = vi.spyOn(process, 'kill');
    const invocation = track(spawnSupervised(process.execPath, childScript("process.stdout.write('ok')"), process.cwd(), process.env, naturalExitTimings));

    await expect(invocation.result).resolves.toMatchObject({ stdout: Buffer.from('ok'), exitCode: 0, signalCode: null });
    expect(invocation.terminated()).toBe(true);
    expect(signalsSent(kill)).toEqual([]);
  });

  it('escalates a SIGTERM-ignoring child to SIGKILL and confirms it', async () => {
    const invocation = track(spawnSupervised(
      process.execPath,
      childScript("process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1_000);"),
      process.cwd(),
      process.env,
      { ...shortTimings, sigtermAfterMs: naturalExitTimings.sigtermAfterMs },
    ));

    const stdout = invocation.child.stdout;
    if (stdout === null) throw new Error('Expected supervised child stdout to be piped');
    await new Promise<void>((resolve) => stdout.once('data', () => resolve()));
    await invocation.terminateAndConfirm();
    await expect(invocation.result).resolves.toMatchObject({ signalCode: 'SIGKILL' });
    expect(invocation.terminated()).toBe(true);
  });

  it('does not settle after a natural parent exit while its SIGTERM-ignoring descendant remains live', async () => {
    const project = await mkdtemp(join(tmpdir(), 'ambercast-supervised-descendant-'));
    projects.push(project);
    const marker = join(project, 'events.log');
    const kill = vi.spyOn(process, 'kill');
    const grandchild = "const fs=require('node:fs'); const marker=process.argv[1]; process.on('SIGTERM',()=>fs.appendFileSync(marker,'term\\n')); fs.appendFileSync(marker, `ready:${process.pid}\\n`); setInterval(()=>{},1000);";
    const parent = `const fs=require('node:fs'); const marker=${JSON.stringify(marker)}; const child=require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}, marker], { stdio: 'ignore' }); const check=setInterval(()=>{ if (fs.existsSync(marker)) { clearInterval(check); child.unref(); } }, 5);`;
    const descendantTimings = { ...shortTimings, sigtermAfterMs: 300 };
    const invocation = track(spawnSupervised(process.execPath, childScript(parent), project, process.env, descendantTimings));
    expect(invocation.child.once).toBeTypeOf('function');
    const parentClosed = new Promise<void>((resolve) => invocation.child.once('close', () => resolve()));
    let settled = false;
    void invocation.result.then(() => { settled = true; }, () => { settled = true; });

    const ready = await waitForMarker(marker, /ready:(\d+)/);
    const grandchildPid = Number(/ready:(\d+)/.exec(ready)?.[1]);
    expect(grandchildPid).toBeGreaterThan(0);
    await parentClosed;
    expect(settled).toBe(false);
    expect(isPidAlive(grandchildPid)).toBe(true);
    await waitForMarker(marker, /term\n/);
    expect(isPidAlive(grandchildPid)).toBe(true);
    await waitFor(() => signalsSent(kill).includes('SIGKILL'), 'SIGKILL escalation');
    expect(signalsSent(kill)).toEqual(['SIGTERM', 'SIGKILL']);
    await waitFor(() => !isPidAlive(grandchildPid), `grandchild ${grandchildPid} to exit`);
    await expect(invocation.result).resolves.toMatchObject({ exitCode: 0 });
    expect(invocation.terminated()).toBe(true);
  });

  it('keeps spawn failure separate from empty-group confirmation', async () => {
    const kill = vi.spyOn(process, 'kill');
    const invocation = track(spawnSupervised('/definitely/not/an-ambercast-command', [], process.cwd(), process.env, naturalExitTimings));

    await expect(invocation.result).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(invocation.terminateAndConfirm()).resolves.toBeUndefined();
    expect(invocation.terminated()).toBe(true);
    expect(signalsSent(kill)).toEqual([]);
  });

  it('bounds termination to a rejection when close never fires after a spawn failure', async () => {
    const kill = vi.spyOn(process, 'kill');
    const invocation = track(spawnSupervised('/definitely/not/an-ambercast-command', [], process.cwd(), process.env, shortTimings));
    // Starves the module's own 'close' listener before any event can reach
    // it: spawn failures only emit events asynchronously, so removing every
    // 'close' listener synchronously, in the same tick spawnSupervised
    // returns in, is a real (not mocked) way to simulate the abnormal
    // runtime where 'close' never arrives, without touching 'error' or
    // changing any public signature.
    invocation.child.removeAllListeners('close');

    await expect(invocation.result).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(invocation.terminateAndConfirm()).rejects.toThrow(/did not confirm termination/i);
    expect(invocation.terminated()).toBe(false);
    expect(signalsSent(kill)).toEqual([]);
  });

  it('settles once when close races the watchdog deadline', async () => {
    const kill = vi.spyOn(process, 'kill');
    const invocation = track(spawnSupervised(process.execPath, childScript('setTimeout(() => process.exit(0), 25)'), process.cwd(), process.env, naturalExitTimings));
    const result = invocation.result;

    await expect(result).resolves.toMatchObject({ exitCode: 0 });
    await expect(invocation.terminateAndConfirm()).resolves.toBeUndefined();
    expect(invocation.terminated()).toBe(true);
    expect(signalsSent(kill)).toEqual([]);
  });

  it('preserves the original spawn error if a fabricated close follows it', async () => {
    const kill = vi.spyOn(process, 'kill');
    const invocation: SupervisedCli = track(spawnSupervised('/definitely/not/an-ambercast-command', [], process.cwd(), process.env, naturalExitTimings));
    const result = invocation.result;
    await expect(result).rejects.toMatchObject({ code: 'ENOENT' });
    expect(invocation.child.emit).toBeTypeOf('function');
    invocation.child.emit('close', 0, null);

    await expect(result).rejects.toMatchObject({ code: 'ENOENT' });
    expect(signalsSent(kill)).toEqual([]);
  });

  it('adapts the built CLI through spawnSupervisedCli', async () => {
    const cliStartupTimings = { ...shortTimings, sigtermAfterMs: 5_000 };
    const invocation = track(spawnSupervisedCli(['--version'], process.cwd(), process.env, cliStartupTimings));
    const result = await invocation.result;

    // build-test (22.14) reported exitCode: null after 531ms, well before the watchdog; the prior exit-code-only matcher left a recurrence opaque.
    expect(result.signalCode, result.stderr.toString()).toBeNull();
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(invocation.terminated()).toBe(true);
  });
});
