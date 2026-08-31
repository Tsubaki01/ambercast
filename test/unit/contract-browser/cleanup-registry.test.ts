import { describe, expect, it, vi } from 'vitest';
import { createCleanupRegistry, type Supervisor } from '../../contract-browser/support/cleanup-registry.js';

function supervisor(task: () => Promise<void> | void): Supervisor {
  return { terminateAndConfirm: vi.fn(async () => { await task(); }) };
}

describe('createCleanupRegistry', () => {
  it('returns the operation value after supervisors and LIFO resources succeed', async () => {
    const registry = createCleanupRegistry();
    const order: string[] = [];
    registry.registerSupervisor(supervisor(async () => { order.push('supervisor'); }));
    registry.deferResource(() => { order.push('first'); });
    registry.deferResource(() => { order.push('second'); });

    await expect(registry.run(async () => 'value')).resolves.toBe('value');
    expect(order).toEqual(['supervisor', 'second', 'first']);
  });

  it('skips every resource when one supervisor fails', async () => {
    const registry = createCleanupRegistry();
    const resource = vi.fn();
    registry.registerSupervisor(supervisor(async () => { throw new Error('supervisor'); }));
    registry.deferResource(resource);

    await expect(registry.run(async () => undefined)).rejects.toThrow('supervisor');
    expect(resource).not.toHaveBeenCalled();
  });

  it('attempts all failing supervisors in registration order and skips resources', async () => {
    const registry = createCleanupRegistry();
    const order: string[] = [];
    const resource = vi.fn();
    registry.registerSupervisor(supervisor(async () => { order.push('first'); throw new Error('first'); }));
    registry.registerSupervisor(supervisor(async () => { order.push('second'); throw new Error('second'); }));
    registry.deferResource(resource);

    await expect(registry.run(async () => undefined)).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(['first', 'second']);
    expect(resource).not.toHaveBeenCalled();
  });

  it('continues LIFO resource cleanup after a resource failure', async () => {
    const registry = createCleanupRegistry();
    const order: string[] = [];
    registry.deferResource(() => { order.push('first'); });
    registry.deferResource(() => { order.push('second'); throw new Error('second'); });
    registry.deferResource(() => { order.push('third'); });

    await expect(registry.run(async () => undefined)).rejects.toThrow('second');
    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('orders operation and multiple supervisor errors', async () => {
    const registry = createCleanupRegistry();
    const operationError = new Error('operation'); const first = new Error('first'); const second = new Error('second');
    registry.registerSupervisor(supervisor(async () => { throw first; }));
    registry.registerSupervisor(supervisor(async () => { throw second; }));

    await expect(registry.run(async () => { throw operationError; })).rejects.toMatchObject({ errors: [operationError, first, second] });
  });

  it('orders operation and multiple resource errors', async () => {
    const registry = createCleanupRegistry();
    const operationError = new Error('operation'); const first = new Error('first'); const second = new Error('second');
    registry.deferResource(() => { throw first; });
    registry.deferResource(() => { throw second; });

    await expect(registry.run(async () => { throw operationError; })).rejects.toMatchObject({ errors: [operationError, second, first] });
  });

  it.each(['operation', 'supervisor', 'resource'] as const)('throws exactly one %s error directly', async (kind) => {
    const registry = createCleanupRegistry();
    const error = new Error(kind);
    if (kind === 'supervisor') registry.registerSupervisor(supervisor(async () => { throw error; }));
    if (kind === 'resource') registry.deferResource(() => { throw error; });

    await expect(registry.run(async () => { if (kind === 'operation') throw error; })).rejects.toBe(error);
  });

  it('propagates an operation error with zero registrations', async () => {
    const registry = createCleanupRegistry();
    const error = new Error('operation');

    await expect(registry.run(async () => { throw error; })).rejects.toBe(error);
  });

  it('propagates an undefined operation rejection reason directly', async () => {
    const registry = createCleanupRegistry();

    await expect(registry.run(async () => { throw undefined; })).rejects.toBeUndefined();
  });

  it('does not start resources before all supervisors settle', async () => {
    const registry = createCleanupRegistry();
    let resolveLast!: () => void;
    const last = new Promise<void>((resolve) => { resolveLast = resolve; });
    const resource = vi.fn();
    registry.registerSupervisor(supervisor(async () => undefined));
    registry.registerSupervisor(supervisor(() => last));
    registry.deferResource(resource);
    const run = registry.run(async () => undefined);

    await Promise.resolve();
    expect(resource).not.toHaveBeenCalled();
    resolveLast();
    await run;
    expect(resource).toHaveBeenCalledOnce();
  });

  it('seals both registration methods once the operation settles', async () => {
    const registry = createCleanupRegistry();
    await registry.run(async () => undefined);

    expect(() => registry.registerSupervisor(supervisor(async () => undefined))).toThrow();
    expect(() => registry.deferResource(() => undefined)).toThrow();
  });

  it('seals registration while supervisor teardown remains pending', async () => {
    const registry = createCleanupRegistry();
    registry.registerSupervisor({
      terminateAndConfirm: vi.fn(async () => {
        expect(() => registry.registerSupervisor(supervisor(async () => undefined))).toThrow();
        expect(() => registry.deferResource(() => undefined)).toThrow();
      }),
    });
    const run = registry.run(async () => 'operation value');

    await expect(run).resolves.toBe('operation value');
  });

  it('rejects a second run after settlement and during teardown', async () => {
    const settled = createCleanupRegistry();
    await settled.run(async () => undefined);
    expect(() => settled.run(async () => undefined)).toThrow();

    const pending = createCleanupRegistry();
    let secondRunThrew = false;
    pending.registerSupervisor(supervisor(async () => {
      expect(() => pending.run(async () => undefined)).toThrow();
      secondRunThrew = true;
    }));
    const first = pending.run(async () => undefined);
    await first;
    expect(secondRunThrew).toBe(true);
  });

  it('tears down fully after an operation rejection and rethrows it directly', async () => {
    const registry = createCleanupRegistry();
    const error = new Error('operation');
    const confirmed = vi.fn(async () => undefined); const resource = vi.fn();
    registry.registerSupervisor({ terminateAndConfirm: confirmed });
    registry.deferResource(resource);

    await expect(registry.run(async () => { throw error; })).rejects.toBe(error);
    expect(confirmed).toHaveBeenCalledOnce();
    expect(resource).toHaveBeenCalledOnce();
  });

  it('continues remaining resources when one resource task throws', async () => {
    const registry = createCleanupRegistry();
    const later = vi.fn();
    registry.deferResource(later);
    registry.deferResource(() => { throw new Error('failure'); });

    await expect(registry.run(async () => undefined)).rejects.toThrow('failure');
    expect(later).toHaveBeenCalledOnce();
  });
});
