import { describe, expect, it, vi } from 'vitest';
import { FrameBudgetMonitor } from './FrameBudgetMonitor.ts';

function feed(monitor: FrameBudgetMonitor, ms: number, frames: number): void {
  for (let i = 0; i < frames; i++) monitor.sample(ms);
}

describe('FrameBudgetMonitor', () => {
  it('lowers the DPR by 0.25 after 60 consecutive slow frames', () => {
    const onChange = vi.fn();
    const monitor = new FrameBudgetMonitor(2, 2, onChange);
    feed(monitor, 30, 59);
    expect(onChange).not.toHaveBeenCalled();
    monitor.sample(30);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(1.75);
  });

  it('raises the DPR by 0.25 after 300 consecutive fast frames', () => {
    const onChange = vi.fn();
    const monitor = new FrameBudgetMonitor(1, 2, onChange);
    feed(monitor, 4, 299);
    expect(onChange).not.toHaveBeenCalled();
    monitor.sample(4);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(1.25);
  });

  it('waits out a 180-frame cooldown after any change', () => {
    const onChange = vi.fn();
    const monitor = new FrameBudgetMonitor(2, 2, onChange);
    feed(monitor, 30, 60);
    expect(onChange).toHaveBeenCalledTimes(1);
    // cooldown 180 + slowFrames 60 の合計 240 フレームで次の降格
    feed(monitor, 30, 239);
    expect(onChange).toHaveBeenCalledTimes(1);
    monitor.sample(30);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(1.5);
  });

  it('never goes below 1 or above the maximum', () => {
    const onChange = vi.fn();
    const monitor = new FrameBudgetMonitor(1, 1.5, onChange);
    feed(monitor, 40, 2000);
    expect(onChange).not.toHaveBeenCalled();

    feed(monitor, 2, 5000);
    const values = onChange.mock.calls.map(([dpr]) => dpr);
    expect(values).toEqual([1.25, 1.5]);
  });

  it('resets the streak when frames land in the neutral band', () => {
    const onChange = vi.fn();
    const monitor = new FrameBudgetMonitor(2, 2, onChange);
    // 30ms を 30 フレーム: 平均は約 25ms。その後 14ms を流すと平均は
    // 約 17 フレームで 18ms を割るので、遅いフレームの連続は 47 で止まる。
    feed(monitor, 30, 30);
    feed(monitor, 14, 200);
    // 再び 30ms を 30 フレーム: 連続が引き継がれていれば 47 + 25 で 60 を超えてしまう。
    feed(monitor, 30, 30);
    expect(onChange).not.toHaveBeenCalled();
    // 連続が途切れていなければ、あと 60 で降格する。
    feed(monitor, 30, 60);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(1.75);
  });

  it('smooths a single spike instead of reacting to it', () => {
    const onChange = vi.fn();
    const monitor = new FrameBudgetMonitor(2, 2, onChange);
    feed(monitor, 5, 100);
    monitor.sample(200);
    feed(monitor, 5, 100);
    expect(onChange).not.toHaveBeenCalled();
  });
});
