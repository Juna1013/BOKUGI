import {
  FLOW_VELOCITY,
  FLOW_WATER_FLOOR,
  FLOW_DRAIN_FRAMES,
  FLOW_DRY_FACTOR,
  FLOW_DEPOSIT_SCALE,
} from '../config.ts';
import type { FluidSolver } from '../physics/FluidSolver.ts';

const STATE_ON = '入';
const STATE_OFF = '切';

/**
 * 流し書き。入にすると紙に薄く水が張られ、書いた墨が一定の流れで運ばれていく。
 * 水で洗い流している最中に書いた時の、墨が流れていく気持ちよさを、
 * 洗い流しとは切り離していつでも使えるようにしたもの。
 * 切にすると水が引き、その時に紙に残っていた墨が落ち着く。
 */
export class FlowController {
  public on = false;
  private drainFrames = 0;
  private readonly button: HTMLButtonElement | null;
  private readonly state: HTMLElement | null;

  constructor(
    private readonly solver: FluidSolver,
    reduceMotion: boolean,
  ) {
    this.button = document.getElementById('flowButton') as HTMLButtonElement | null;
    this.state = this.button?.querySelector('.flow-button__state') ?? null;
    if (!this.button) return;
    // 動きを抑える設定では流体を毎フレーム進めないので、流れも起きない。ボタンごと出さない。
    if (reduceMotion) {
      this.button.hidden = true;
      return;
    }
    this.button.addEventListener('click', () => this.set(!this.on));
  }

  public set(on: boolean): void {
    if (this.on && !on) this.drainFrames = FLOW_DRAIN_FRAMES;
    if (on) this.drainFrames = 0;
    this.on = on;
    // 入の間は墨を浮かせたまま運び、切にした時に紙に残っている墨を落ち着かせる
    this.solver.depositScale = on ? FLOW_DEPOSIT_SCALE : 1;
    this.button?.classList.toggle('is-on', on);
    this.button?.setAttribute('aria-pressed', String(on));
    if (this.state) this.state.textContent = on ? STATE_ON : STATE_OFF;
  }

  /** 毎フレーム、移流の後に呼ぶ。水で洗い流している間はそちらの流れに任せる。 */
  public step(rinsing: boolean): void {
    if (rinsing) {
      this.drainFrames = 0;
      return;
    }
    if (this.on) {
      this.solver.flowStep(FLOW_VELOCITY[0], FLOW_VELOCITY[1], FLOW_WATER_FLOOR, 1);
    } else if (this.drainFrames > 0) {
      this.drainFrames--;
      this.solver.flowStep(0, 0, 0, FLOW_DRY_FACTOR);
    }
  }
}
