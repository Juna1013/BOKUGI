export type ShadingDetail = 'full' | 'basic';

export interface RenderQuality {
  dpr: number;
  /** 画素単位の毛羽・艶・三次補間を使うか。最後の段でだけ落とす。 */
  detail: ShadingDetail;
}

/** これより遅ければ品質を下げ、これより速ければ上げる（rAF の実フレーム間隔、ms）。 */
const SLOW_FRAME_MS = 24;
const FAST_FRAME_MS = 17.5;
/** 無操作やタブ切り替えで空いた間隔はフレームコストではないので捨てる。 */
const GAP_RESET_MS = 200;

/**
 * 実フレーム間隔で描画品質を上下させる。
 *
 * CPU 側の処理時間ではなく requestAnimationFrame の間隔を測るのは、GPU パスでは
 * CPU はコマンドを発行するだけで、GPU が飽和してもその時間には現れないから。
 * GPU が間に合わなければブラウザが次のフレームを遅らせるので、間隔に出る。
 *
 * 段階は DPR を 0.25 刻みで 1 まで下げ、それでも遅ければ画素シェーディングを簡略化する。
 * 上げる時は逆順。
 */
export class FrameBudgetMonitor {
  private averageInterval = 0;
  private slowFrames = 0;
  private fastFrames = 0;
  private cooldown = 0;
  private lastFrameTime: number | null = null;
  private quality: RenderQuality;

  constructor(
    initial: RenderQuality,
    private readonly maxDpr: number,
    private readonly onChange: (quality: RenderQuality) => void,
  ) {
    this.quality = { ...initial };
  }

  public get current(): RenderQuality {
    return { ...this.quality };
  }

  /** rAF のタイムスタンプ。シミュレーションが実際に動いたフレームだけを渡す。 */
  public sample(frameTime: number): void {
    const previous = this.lastFrameTime;
    this.lastFrameTime = frameTime;
    if (previous === null) return;
    const interval = frameTime - previous;
    if (interval <= 0 || interval > GAP_RESET_MS) return;

    this.averageInterval = this.averageInterval === 0
      ? interval
      : this.averageInterval * 0.94 + interval * 0.06;

    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }

    if (this.averageInterval > SLOW_FRAME_MS) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (this.averageInterval < FAST_FRAME_MS) {
      this.fastFrames++;
      this.slowFrames = 0;
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }

    if (this.slowFrames >= 45) this.stepDown();
    else if (this.fastFrames >= 300) this.stepUp();
  }

  /** 品質を測り直す（表示領域が変わった時など）。 */
  public reset(): void {
    this.lastFrameTime = null;
    this.averageInterval = 0;
    this.slowFrames = 0;
    this.fastFrames = 0;
  }

  private stepDown(): void {
    const { dpr, detail } = this.quality;
    if (dpr > 1) this.change({ dpr: Math.max(1, dpr - 0.25), detail });
    else if (detail === 'full') this.change({ dpr, detail: 'basic' });
    else this.slowFrames = 0;
  }

  private stepUp(): void {
    const { dpr, detail } = this.quality;
    if (detail === 'basic') this.change({ dpr, detail: 'full' });
    else if (dpr < this.maxDpr) this.change({ dpr: Math.min(this.maxDpr, dpr + 0.25), detail });
    else this.fastFrames = 0;
  }

  private change(quality: RenderQuality): void {
    this.quality = quality;
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.cooldown = 180;
    this.onChange({ ...quality });
  }
}
