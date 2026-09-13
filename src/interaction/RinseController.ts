import type { FluidSolver } from '../physics/FluidSolver.ts';

/** style.css の .rinse.is-holding::before の transition 時間と揃える。 */
const HOLD_DURATION_MS = 900;
/** 短いタップの後に長押しの案内を出しておく時間。 */
const TIP_DURATION_MS = 3000;
const HOLD_TIP = '長押しで 水が流れます';

export class RinseController {
  public solver: FluidSolver;
  public reduceMotion: boolean;
  public renderFn: () => void;
  public rinsing: number = 0;
  public R_SWEEP: number = 70;
  public R_TOTAL: number = 290;
  private enabled = true;
  private readonly button: HTMLButtonElement | null;
  private readonly tip: HTMLElement | null;
  private holdTimer: ReturnType<typeof setTimeout> | undefined;
  private holdPointerId: number | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    solver: FluidSolver,
    reduceMotion: boolean,
    renderFn: () => void,
  ) {
    this.solver = solver;
    this.reduceMotion = reduceMotion;
    this.renderFn = renderFn;
    this.button = document.getElementById('rinse') as HTMLButtonElement | null;
    this.tip = document.getElementById('rinseTip');
    this.initEvents();
  }

  /** 長押しの水満ち演出中（まだ水は流れていない）。 */
  public get holdPending(): boolean {
    return this.holdTimer !== undefined;
  }

  /**
   * 一発勝負の作品を誤タップで流さないよう、ポインターでは長押しでだけ始める。
   * キーボードは意図せず押すことがないため、Enter / Space で即座に始める。
   *
   * 初見の人は必ず一度は短くタップする。その時に水が引いていくのを見せ、
   * 「長押しで流れる」と案内して、次の一回で成功できるようにする。
   */
  private initEvents(): void {
    const button = this.button;
    if (!button) return;

    button.addEventListener('pointerdown', (e: PointerEvent) => {
      if (!this.enabled || this.rinsing || this.holdPending) return;
      if (e.button !== 0) return;
      this.holdPointerId = e.pointerId;
      try {
        button.setPointerCapture(e.pointerId);
      } catch (_) {}
      this.startHold();
    });

    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.holdPointerId) return;
      // holdPointerId が残っているのは水が満ちる前に離した時だけ
      this.cancelHold();
      if (e.type === 'pointerup') this.showTip();
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

  /**
   * 待機画面のデモ用。来場者が長押しした時と同じく、
   * ボタンに水が満ちてから流し始める。
   */
  public beginWithHoldCue(): void {
    if (!this.enabled || this.rinsing || this.holdPending) return;
    this.startHold();
  }

  private startHold(): void {
    this.button?.classList.add('is-holding');
    this.holdTimer = setTimeout(() => {
      this.cancelHold();
      this.begin();
    }, HOLD_DURATION_MS);
  }

  private begin(): void {
    if (!this.enabled || this.rinsing) return;
    this.hideTip();
    if (this.reduceMotion) {
      this.solver.clearAll();
      this.renderFn();
    } else {
      this.rinsing = 1;
    }
  }

  public cancelHold(): void {
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

  private showTip(): void {
    const tip = this.tip;
    if (!tip) return;
    if (this.tipTimer !== undefined) clearTimeout(this.tipTimer);
    tip.textContent = HOLD_TIP;
    tip.classList.add('is-visible');
    this.tipTimer = setTimeout(() => this.hideTip(), TIP_DURATION_MS);
  }

  private hideTip(): void {
    if (this.tipTimer !== undefined) {
      clearTimeout(this.tipTimer);
      this.tipTimer = undefined;
    }
    this.tip?.classList.remove('is-visible');
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
