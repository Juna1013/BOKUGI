import type { FluidSolver } from '../physics/FluidSolver.ts';

/** style.css の .rinse.is-holding アニメーション時間と揃える。 */
const HOLD_DURATION_MS = 900;

export class RinseController {
  public solver: FluidSolver;
  public reduceMotion: boolean;
  public renderFn: () => void;
  public rinsing: number = 0;
  public R_SWEEP: number = 70;
  public R_TOTAL: number = 290;
  private enabled = true;
  private readonly button: HTMLButtonElement | null;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private holdPointerId: number | null = null;

  constructor(
    solver: FluidSolver,
    reduceMotion: boolean,
    renderFn: () => void,
  ) {
    this.solver = solver;
    this.reduceMotion = reduceMotion;
    this.renderFn = renderFn;
    this.button = document.getElementById('rinse') as HTMLButtonElement | null;
    this.initEvents();
  }

  /**
   * 一発勝負の作品を誤タップで流さないよう、ポインターでは長押しでだけ始める。
   * キーボードは意図せず押すことがないため、Enter / Space で即座に始める。
   */
  private initEvents(): void {
    const button = this.button;
    if (!button) return;

    button.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.enabled || this.rinsing || this.holdPointerId !== null) return;
      if (e.button !== 0) return;
      this.holdPointerId = e.pointerId;
      try {
        button.setPointerCapture(e.pointerId);
      } catch (_) {}
      button.classList.add('is-holding');
      this.holdTimer = setTimeout(() => {
        this.cancelHold();
        this.begin();
      }, HOLD_DURATION_MS);
    });

    const release = (e: PointerEvent) => {
      if (e.pointerId === this.holdPointerId) this.cancelHold();
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', release);

    // 長押し中にOSのコンテキストメニューやテキスト選択を出さない
    button.addEventListener('contextmenu', (e) => e.preventDefault());

    button.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (e.repeat) return;
      this.begin();
    });
  }

  private begin(): void {
    if (!this.enabled || this.rinsing) return;
    if (this.reduceMotion) {
      this.solver.clearAll();
      this.renderFn();
    } else {
      this.rinsing = 1;
    }
  }

  private cancelHold(): void {
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
    }
    const pointerId = this.holdPointerId;
    this.holdPointerId = null;
    this.button?.classList.remove('is-holding');
    if (pointerId === null) return;
    try {
      this.button?.releasePointerCapture(pointerId);
    } catch (_) {}
  }

  public step(): void {
    if (!this.rinsing) return;
    this.solver.rinseStep(this.rinsing, this.R_SWEEP, this.R_TOTAL);
    if (++this.rinsing > this.R_TOTAL) {
      this.solver.clearAll();
      this.rinsing = 0;
    }
  }

  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancelHold();
  }
}
