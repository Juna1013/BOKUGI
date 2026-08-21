export class FrameBudgetMonitor {
  private averageCost = 0;
  private slowFrames = 0;
  private fastFrames = 0;
  private cooldown = 0;

  constructor(
    private currentDpr: number,
    private readonly maxDpr: number,
    private readonly onChange: (dpr: number) => void,
  ) {}

  /** シミュレーションが実際に動いたフレームだけを渡す。 */
  public sample(processingMs: number): void {
    this.averageCost = this.averageCost === 0
      ? processingMs
      : this.averageCost * 0.94 + processingMs * 0.06;

    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }

    if (this.averageCost > 18) {
      this.slowFrames++;
      this.fastFrames = 0;
    } else if (this.averageCost < 10) {
      this.fastFrames++;
      this.slowFrames = 0;
    } else {
      this.slowFrames = 0;
      this.fastFrames = 0;
    }

    if (this.slowFrames >= 60 && this.currentDpr > 1) {
      this.change(Math.max(1, this.currentDpr - 0.25));
    } else if (this.fastFrames >= 300 && this.currentDpr < this.maxDpr) {
      this.change(Math.min(this.maxDpr, this.currentDpr + 0.25));
    }
  }

  private change(dpr: number): void {
    this.currentDpr = dpr;
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.cooldown = 180;
    this.onChange(dpr);
  }
}
