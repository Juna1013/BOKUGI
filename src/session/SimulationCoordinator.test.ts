import { describe, expect, it, vi } from 'vitest';
import { SimulationCoordinator } from './SimulationCoordinator.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SimulationCoordinator', () => {
  it('runs tasks strictly one after another', async () => {
    const coordinator = new SimulationCoordinator(() => {});
    const order: string[] = [];
    const first = deferred<void>();

    const a = coordinator.runExclusive(async () => { order.push('a:start'); await first.promise; order.push('a:end'); });
    const b = coordinator.runExclusive(() => { order.push('b'); return 42; });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    first.resolve();
    await a;
    expect(await b).toBe(42);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('keeps going after a task rejects', async () => {
    const coordinator = new SimulationCoordinator(() => {});
    const failing = coordinator.runExclusive(() => { throw new Error('boom'); });
    const next = coordinator.runExclusive(() => 'ok');
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });

  it('reports busy around each task, including failures', async () => {
    const onBusy = vi.fn();
    const coordinator = new SimulationCoordinator(onBusy);
    await coordinator.runExclusive(() => 1);
    await coordinator.runExclusive(() => Promise.reject(new Error('x'))).catch(() => {});
    expect(onBusy.mock.calls.map(([b]) => b)).toEqual([true, false, true, false]);
  });

  it('returns the task result with its type preserved', async () => {
    const coordinator = new SimulationCoordinator(() => {});
    const value = await coordinator.runExclusive(async () => ({ width: 3 }));
    expect(value.width).toBe(3);
  });
});
