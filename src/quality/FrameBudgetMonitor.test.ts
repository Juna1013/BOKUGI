import { describe, expect, it, vi } from 'vitest';
import { FrameBudgetMonitor, type RenderQuality } from './FrameBudgetMonitor.ts';

/**
 * sample() は rAF のタイムスタンプを受け取るので、間隔を刻んだ時計を進めて渡す。
 * 最初の 1 回は基準になるだけで、間隔は 2 回目から測られる。
 */
class Clock {
  private now = 0;
  constructor(private readonly monitor: FrameBudgetMonitor) {
    monitor.sample(this.now);
  }
  feed(intervalMs: number, frames: number): void {
    for (let i = 0; i < frames; i++) {
      this.now += intervalMs;
      this.monitor.sample(this.now);
    }
  }
}

const full = (dpr: number): RenderQuality => ({ dpr, detail: 'full' });
const basic = (dpr: number): RenderQuality => ({ dpr, detail: 'basic' });

describe('FrameBudgetMonitor', () => {
  it('lowers the DPR by 0.25 after 45 consecutive slow frames', () => {
    const onChange = vi.fn();
    const clock = new Clock(new FrameBudgetMonitor(full(2), 2, onChange));
    clock.feed(30, 44);
    expect(onChange).not.toHaveBeenCalled();
    clock.feed(30, 1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(full(1.75));
  });

  it('raises the DPR by 0.25 after 300 consecutive fast frames', () => {
    const onChange = vi.fn();
    const clock = new Clock(new FrameBudgetMonitor(full(1), 2, onChange));
    clock.feed(10, 299);
    expect(onChange).not.toHaveBeenCalled();
    clock.feed(10, 1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(full(1.25));
  });

  it('waits out a 180-frame cooldown after any change', () => {
    const onChange = vi.fn();
    const clock = new Clock(new FrameBudgetMonitor(full(2), 2, onChange));
    clock.feed(30, 45);
    expect(onChange).toHaveBeenCalledTimes(1);
    // cooldown 180 + slowFrames 45 の合計 225 フレームで次の降格
    clock.feed(30, 224);
    expect(onChange).toHaveBeenCalledTimes(1);
    clock.feed(30, 1);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(full(1.5));
  });

  it('drops to basic shading once the DPR is already 1, and climbs back in reverse order', () => {
    const onChange = vi.fn();
    const clock = new Clock(new FrameBudgetMonitor(full(1), 1.5, onChange));
    clock.feed(40, 2000);
    expect(onChange.mock.calls.map(([quality]) => quality)).toEqual([basic(1)]);

    clock.feed(5, 5000);
    expect(onChange.mock.calls.map(([quality]) => quality)).toEqual([
      basic(1),
      full(1),
      full(1.25),
      full(1.5),
    ]);
  });

  it('resets the streak when frames land in the neutral band', () => {
    const onChange = vi.fn();
    const clock = new Clock(new FrameBudgetMonitor(full(2), 2, onChange));
    // 30ms を 20 フレーム、続けて 20ms を 100 フレーム。移動平均が 24ms を割った後は
    // 中立帯なので、遅いフレームの連続は 45 に届かず 0 に戻る。
    clock.feed(30, 20);
    clock.feed(20, 100);
    // 再び 30ms を 30 フレーム。平均が 24ms を越えるのは 9 フレーム目からで、
    // 連続が引き継がれていれば 35 + 22 で 45 を超えてしまう。
    clock.feed(30, 30);
    expect(onChange).not.toHaveBeenCalled();
    // 連続が途切れていれば、あと 23 で降格する。
    clock.feed(30, 30);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(full(1.75));
  });

  it('smooths a single spike instead of reacting to it', () => {
    const onChange = vi.fn();
    const clock = new Clock(new FrameBudgetMonitor(full(2), 2, onChange));
    clock.feed(5, 100);
    clock.feed(190, 1);
    clock.feed(5, 100);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores idle gaps longer than 200ms without breaking the streak', () => {
    const onChange = vi.fn();
    const clock = new Clock(new FrameBudgetMonitor(full(1), 2, onChange));
    clock.feed(10, 100);
    clock.feed(5000, 1);
    clock.feed(10, 199);
    expect(onChange).not.toHaveBeenCalled();
    clock.feed(10, 1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(full(1.25));
  });

  it('reports the current quality and starts measuring afresh after reset()', () => {
    const onChange = vi.fn();
    const monitor = new FrameBudgetMonitor(full(2), 2, onChange);
    const clock = new Clock(monitor);
    clock.feed(30, 45);
    expect(monitor.current).toEqual(full(1.75));

    monitor.reset();
    // reset 後の最初の sample は基準になるだけ。cooldown は残るので、
    // 180 + 45 フレームで次の降格になる。
    clock.feed(30, 225);
    expect(onChange).toHaveBeenCalledTimes(1);
    clock.feed(30, 1);
    expect(onChange).toHaveBeenLastCalledWith(full(1.5));
  });
});
