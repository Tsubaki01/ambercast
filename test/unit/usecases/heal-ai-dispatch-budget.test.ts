import { describe, expect, it, vi } from 'vitest';
import { createHealAiDispatchBudget, type HealAiDispatchPhaseDeps } from '#usecases/heal-ai-dispatch-budget.js';
import { createFakeAiExecutor } from '../../doubles/fake-ai-executor.js';

const request = {} as never;

function createBudget(params: Partial<Parameters<typeof createHealAiDispatchBudget>[0]> = {}) {
  let now = 0;
  const executor = createFakeAiExecutor({
    execute: async () => ({ data: { ok: true }, raw: '{}' }),
    executeAgentic: async () => ({ outcome: 'success' }),
  });
  const resolveAiExecutor = vi.fn(async () => executor);
  const budget = createHealAiDispatchBudget({
    resolveAiExecutor,
    signal: undefined,
    clock: { monotonicMs: () => now },
    deadlineMs: 100,
    maxDispatches: Infinity,
    ...params,
  });

  return { budget, executor, resolveAiExecutor, setNow: (value: number) => { now = value; } };
}

describe('createHealAiDispatchBudget', () => {
  it('denies an expired phase before work or lazy executor resolution begins', async () => {
    const fixture = createBudget({ deadlineMs: 0 });
    const work = vi.fn(async (deps: HealAiDispatchPhaseDeps) => deps.resolveAiExecutor());

    await expect(fixture.budget.runPhase('incremental', work)).resolves.toEqual({
      admitted: false,
      deniedReason: 'deadline',
    });
    expect(work).not.toHaveBeenCalled();
    expect(fixture.resolveAiExecutor).not.toHaveBeenCalled();
  });

  it('gives deadline denial precedence when deadline and limit are both exhausted', async () => {
    const fixture = createBudget({ maxDispatches: 1 });

    await expect(fixture.budget.runPhase('incremental', async (deps) => {
      const executor = await deps.resolveAiExecutor();
      await executor.execute(request);
      return 'consumed the only dispatch';
    })).resolves.toEqual({ admitted: true, result: { ok: true, value: 'consumed the only dispatch' } });

    fixture.setNow(100);

    await expect(fixture.budget.runPhase('incremental', async () => 'unreachable')).resolves.toEqual({
      admitted: false,
      deniedReason: 'deadline',
    });
  });

  it('does not limit-deny stage 3 phases but still deadline-denies them', async () => {
    const fixture = createBudget({ maxDispatches: 1 });

    await expect(fixture.budget.runPhase('incremental', async (deps) => {
      const executor = await deps.resolveAiExecutor();
      await executor.execute(request);
      return 'consumed the only dispatch';
    })).resolves.toEqual({ admitted: true, result: { ok: true, value: 'consumed the only dispatch' } });

    await expect(fixture.budget.runPhase('stage3', async (deps) => {
      const executor = await deps.resolveAiExecutor();
      await executor.execute(request);
      return 'allowed';
    })).resolves.toEqual({ admitted: true, result: { ok: true, value: 'allowed' } });

    fixture.setNow(100);
    await expect(fixture.budget.runPhase('stage3', async () => 'unreachable')).resolves.toEqual({
      admitted: false,
      deniedReason: 'deadline',
    });
  });

  it.each([NaN, -1, 1.5])('rejects an invalid finite maxDispatches value: %s', (maxDispatches) => {
    expect(() => createBudget({ maxDispatches })).toThrow();
  });

  it.each([Infinity, 1])('accepts the documented maxDispatches value: %s', (maxDispatches) => {
    expect(() => createBudget({ maxDispatches })).not.toThrow();
  });

  it('latches a phase denied by its second dispatch and discards its returned value', async () => {
    const fixture = createBudget({ maxDispatches: 1 });

    await expect(fixture.budget.runPhase('incremental', async (deps) => {
      const executor = await deps.resolveAiExecutor();
      await executor.execute(request);
      await executor.execute(request);
      return 'must be discarded';
    })).resolves.toEqual({ admitted: false, deniedReason: 'attempt-limit' });
  });

  it('preserves an admitted ordinary work error exactly', async () => {
    const fixture = createBudget();
    const error = new Error('ordinary failure');

    const outcome = await fixture.budget.runPhase('incremental', async () => { throw error; });

    expect(outcome).toEqual({ admitted: true, result: { ok: false, error } });
  });

  it('passes through executor identity members and does not meter isAvailable', async () => {
    const fixture = createBudget({ maxDispatches: 1 });
    const isAvailable = vi.spyOn(fixture.executor, 'isAvailable');

    const outcome = await fixture.budget.runPhase('incremental', async (deps) => {
      const executor = await deps.resolveAiExecutor();
      return {
        name: executor.name,
        available: await executor.isAvailable(),
      };
    });

    expect(outcome).toEqual({ admitted: true, result: { ok: true, value: {
      name: fixture.executor.name,
      available: true,
    } } });
    expect(isAvailable).toHaveBeenCalledOnce();
  });

  it('rejects reentrant phases before nested work can start', async () => {
    const fixture = createBudget();
    const nestedWork = vi.fn(async () => 'nested');

    const outcome = await fixture.budget.runPhase('incremental', async () => {
      await expect(fixture.budget.runPhase('incremental', nestedWork)).rejects.toThrow(/phase/i);
      return 'outer';
    });

    expect(outcome).toEqual({ admitted: true, result: { ok: true, value: 'outer' } });
    expect(nestedWork).not.toHaveBeenCalled();
  });

  it('charges execute and executeAgentic against one shared counter', async () => {
    const fixture = createBudget({ maxDispatches: 1 });

    await expect(fixture.budget.runPhase('incremental', async (deps) => {
      const executor = await deps.resolveAiExecutor();
      await executor.execute(request);
      await executor.executeAgentic(request);
      return 'must be discarded';
    })).resolves.toEqual({ admitted: false, deniedReason: 'attempt-limit' });
  });

  it('never limit-denies an unbounded incremental budget', async () => {
    const fixture = createBudget({ maxDispatches: Infinity });

    await expect(fixture.budget.runPhase('incremental', async (deps) => {
      const executor = await deps.resolveAiExecutor();
      await executor.execute(request);
      await executor.executeAgentic(request);
      await executor.execute(request);
      return 'unbounded';
    })).resolves.toEqual({ admitted: true, result: { ok: true, value: 'unbounded' } });
  });
});
