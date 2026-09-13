import { CS } from '../config.ts';
import type { FluidSolver } from '../physics/FluidSolver.ts';
import type { RinseController } from '../interaction/RinseController.ts';
import type { ColorIndex } from '../types/physics.ts';

/** 無操作がこの時間続いたら待機画面に入る。 */
const IDLE_MS = 60_000;
const DEFAULT_HINT = '紙に触れてください';

export interface AttractHooks {
  /** 待機画面に入る直前。前の来場者のセッション状態（作者名など）を破棄する。 */
  onEnter?: () => void;
}

type Act = {
  hint: string;
  frames: number;
  /** frame は 0 から frames-1。W, H はその時点の表示領域。 */
  run?: (frame: number, W: number, H: number) => void;
};

/**
 * 展示端末の待機画面。無人になった端末で墨の所作を自動再生して人を呼び、
 * 来場者が触れた瞬間に白紙へ戻してその一筆から作品を始める。
 *
 * 通常モードでは生成しないこと。自分のスマートフォンで遊んでいる人の
 * 目の前で勝手に墨が落ちることになる。
 */
export class AttractController {
  private state: 'off' | 'rinsing' | 'demo' = 'off';
  private enabled = true;
  private lastActivity = performance.now();
  /** 白紙だと分かっている間は、待機画面に入る時の水流しを省く。 */
  private paperBlank = true;
  private wasRinsing = false;

  private actIndex = 0;
  private actFrame = 0;
  private strokeX = 0;
  private strokeY = 0;

  private readonly hint: HTMLElement | null;
  private readonly hintText: HTMLElement | null;
  private readonly acts: readonly Act[];

  constructor(
    private readonly solver: FluidSolver,
    private readonly rinseController: RinseController,
    private readonly inkCanvas: HTMLCanvasElement,
    private readonly renderFn: () => void,
    private readonly hooks: AttractHooks = {},
  ) {
    this.hint = document.getElementById('hint');
    this.hintText = this.hint?.querySelector('span') ?? null;
    this.acts = this.buildActs();

    // 端末のどこに触れても「人がいる」と見なす。キャンバスの pointerdown より
    // 先に白紙へ戻すため、window の capture 段階で受ける。
    window.addEventListener('pointerdown', (e) => this.onActivity(e), { capture: true });
    window.addEventListener('keydown', () => this.onActivity(null), { capture: true });
  }

  public get active(): boolean {
    return this.state !== 'off';
  }

  /** readback や書き出しの最中は、デモの落墨も待機画面への遷移も止める。 */
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** 毎フレーム、シミュレーションを進める前に呼ぶ。 */
  public update(): void {
    // 来場者の水流しが終わった時点で白紙になったことを記録する
    const rinsing = this.rinseController.rinsing > 0;
    if (this.wasRinsing && !rinsing && this.state === 'off') this.paperBlank = true;
    this.wasRinsing = rinsing;

    if (!this.enabled) return;

    if (this.state === 'off') {
      if (performance.now() - this.lastActivity >= IDLE_MS) this.enter();
      return;
    }

    if (this.state === 'rinsing') {
      if (this.rinseController.rinsing > 0) return;
      this.paperBlank = true;
      this.startDemo();
      return;
    }

    this.runDemoFrame();
  }

  private onActivity(e: PointerEvent | null): void {
    this.lastActivity = performance.now();
    if (e && e.target === this.inkCanvas) this.paperBlank = false;
    if (this.state !== 'off') this.leave();
  }

  private enter(): void {
    this.hooks.onEnter?.();
    this.showHint(DEFAULT_HINT);

    // 前の来場者の作品が残っていれば、水で流してから始める
    this.state = 'rinsing';
    if (!this.paperBlank && this.rinseController.rinsing === 0) {
      this.rinseController.rinsing = 1;
    }
  }

  /** 来場者が触れた。デモの墨をすべて消し、その入力を最初の一筆にする。 */
  private leave(): void {
    this.state = 'off';
    this.rinseController.rinsing = 0;
    this.solver.clearAll();
    this.renderFn();
    this.showHint(DEFAULT_HINT);
    this.paperBlank = true;
  }

  private startDemo(): void {
    this.state = 'demo';
    this.actIndex = 0;
    this.actFrame = 0;
    this.showHint(this.acts[0]?.hint ?? DEFAULT_HINT);
  }

  private runDemoFrame(): void {
    const act = this.acts[this.actIndex];
    if (!act) {
      this.startDemo();
      return;
    }
    const { W, H } = this.solver.grid;
    act.run?.(this.actFrame, W, H);

    if (++this.actFrame < act.frames) return;

    this.actFrame = 0;
    this.actIndex++;
    const next = this.acts[this.actIndex];
    if (!next) {
      // 一巡したら流して最初から
      this.state = 'rinsing';
      this.paperBlank = false;
      this.rinseController.rinsing = 1;
      return;
    }
    this.showHint(next.hint);
  }

  private showHint(text: string): void {
    if (this.hintText) this.hintText.textContent = text;
    this.hint?.classList.remove('gone');
  }

  /**
   * 所作の台本。InputController と同じ落墨の式を使い、
   * 「ゆっくり引く」「速く払う」「押し続ける」「ひと触れ」の違いを順に見せる。
   */
  private buildActs(): Act[] {
    const settle = (frames: number, hint: string): Act => ({ hint, frames });

    return [
      {
        hint: 'ゆっくり引くと 濃く',
        frames: 120,
        run: (frame, W, H) => {
          const t = frame / 119;
          const ease = t * t * (3 - 2 * t);
          const x = W * (0.30 + 0.40 * ease);
          const y = H * (0.40 + 0.04 * Math.sin(ease * Math.PI));
          if (frame === 0) this.beginStroke(x, y, 0);
          else this.strokeTo(x, y, 1.05, 0);
        },
      },
      settle(80, 'ゆっくり引くと 濃く'),
      {
        hint: '速く払うと かすれる',
        frames: 18,
        run: (frame, W, H) => {
          const t = frame / 17;
          const x = W * (0.34 + 0.34 * t);
          const y = H * (0.66 - 0.12 * t);
          if (frame === 0) this.beginStroke(x, y, 0);
          else this.strokeTo(x, y, 0.25, 0, 3.2);
        },
      },
      settle(80, '速く払うと かすれる'),
      {
        hint: '押し続けると 滲む',
        frames: 130,
        run: (frame, W, H) => {
          const x = W * 0.50, y = H * 0.55;
          if (frame === 0) {
            this.beginStroke(x, y, 0);
          } else if (frame > 20 && frame % 6 === 0) {
            this.stamp(x, y, 0.5, 4.0, 0);
          }
        },
      },
      settle(60, '押し続けると 滲む'),
      {
        hint: 'ひと触れで 渦が生まれる',
        frames: 1,
        run: (_frame, W, H) => this.beginStroke(W * 0.64, H * 0.64, 1),
      },
      settle(720, DEFAULT_HINT),
    ];
  }

  /** pointerdown 相当。中程度の筆圧で落墨し、渦を付ける。 */
  private beginStroke(x: number, y: number, color: ColorIndex): void {
    this.strokeX = x;
    this.strokeY = y;
    this.stamp(x, y, 1.6, 4.5, color);
    this.solver.swirl(x, y);
  }

  /**
   * pointermove 相当。前回位置から線補間で落墨する。
   * speedAmount は InputController の速度による減衰（遅い: 1.1、速い: 0.25）。
   * velocityGain を渡すと払いの流速を付ける。
   */
  private strokeTo(
    x: number,
    y: number,
    speedAmount: number,
    color: ColorIndex,
    velocityGain = 0,
  ): void {
    const dx = x - this.strokeX;
    const dy = y - this.strokeY;
    const dist = Math.hypot(dx, dy);
    const cellSize = this.solver.grid.CS;
    if (dist <= cellSize) return;

    const radiusScale = CS / cellSize;
    if (velocityGain > 0) {
      this.solver.addVel(x, y, (dx / dist) * velocityGain, (dy / dist) * velocityGain, 6 * radiusScale);
    }

    const count = Math.ceil(dist / cellSize);
    for (let k = 1; k <= count; k++) {
      const progress = k / count;
      this.stamp(
        this.strokeX + dx * progress,
        this.strokeY + dy * progress,
        speedAmount * 0.45,
        3.2,
        color,
      );
    }
    this.strokeX = x;
    this.strokeY = y;
  }

  private stamp(x: number, y: number, amount: number, radius: number, color: ColorIndex): void {
    this.solver.deposit(
      x,
      y,
      amount,
      amount * 0.55,
      radius * (CS / this.solver.grid.CS),
      color,
    );
  }
}
