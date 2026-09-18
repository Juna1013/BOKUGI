import {
  DIFF,
  CAP,
  EVAP,
  VDAMP,
  DEPOSIT_WET,
  DEPOSIT_DRY,
  EDGE_DEPOSIT,
  EDGE_WATER_FLOOR,
  EDGE_RATE_MAX,
  FLOW_RELAX,
  FLOW_JITTER,
  FLOW_SINK_CELLS,
  FLOW_SINK_WATER,
  FLOW_SINK_PIGMENT,
} from '../config.ts';
import type { FluidGrid } from './FluidGrid.ts';
import type { ColorIndex } from '../types/physics.ts';

export interface PreservingResizeOptions {
  /** GPU readback中に要求が古くなった場合、格子を書き換える直前で中止する。 */
  shouldApply?: () => boolean;
  /** 旧格子の履歴など、再サンプリング前に解放できるメモリを破棄する。 */
  beforeResize?: () => void;
}

/**
 * 8近傍の並び。軸方向 4 つ、斜め 4 つ。GPU 版の offsets と同じ順序にすること。
 * 斜めは距離が √2 あるので重みを半分にし、合計が従来の 4 近傍と同じ 4 になるよう正規化する。
 */
const NEIGHBOR_DX: readonly number[] = [-1, 1, 0, 0, 1, -1, 1, -1];
const NEIGHBOR_DY: readonly number[] = [0, 0, -1, 1, 1, -1, -1, 1];
/** 浮遊顔料がこれを下回ったら 0 とみなす。表示上 1/255 階調にも届かない量。 */
const PIGMENT_EPSILON = 1e-5;
const AXIAL_WEIGHT = 2 / 3;
const DIAGONAL_WEIGHT = 1 / 3;

/**
 * 繊維方向による拡散の重み。繊維の軸 θ と近傍方向 φ の差で 1 + A·cos(2(φ−θ)) を返す。
 * 軸方向は cos2θ、斜め方向は sin2θ で決まり、8方向の合計は θ によらず 4 のまま。
 */
export function fiberWeight(neighbor: number, cos2: number, sin2: number): number {
  if (neighbor < 2) return AXIAL_WEIGHT * (1 + cos2);   // (±1, 0)
  if (neighbor < 4) return AXIAL_WEIGHT * (1 - cos2);   // (0, ±1)
  if (neighbor < 6) return DIAGONAL_WEIGHT * (1 + sin2); // (1, 1), (-1, -1)
  return DIAGONAL_WEIGHT * (1 - sin2);                   // (1, -1), (-1, 1)
}

/** 中央差分による水分勾配の大きさ。端は片側差分で代用する。 */
export function waterGradient(w: Float32Array, i: number, gw: number, gh: number): number {
  const x = i % gw, y = (i - x) / gw;
  const left = w[x > 0 ? i - 1 : i] ?? 0;
  const right = w[x < gw - 1 ? i + 1 : i] ?? 0;
  const up = w[y > 0 ? i - gw : i] ?? 0;
  const down = w[y < gh - 1 ? i + gw : i] ?? 0;
  const gx = (right - left) * 0.5;
  const gy = (down - up) * 0.5;
  return Math.sqrt(gx * gx + gy * gy);
}

/**
 * 顔料の定着率。乾くほど定着が進む従来項に、濡れ際で高まる縁取り項を足す。
 * 濡れ際は水分に対して勾配が大きく、そこへ毛細管流で運ばれた顔料が留まって縁が濃くなる。
 * 芯は勾配がほぼ 0 なので顔料が浮いたまま外へ運ばれ、乾いた後は縁より淡くなる。
 */
export function depositionRate(water: number, gradient: number): number {
  const dry = 1 - Math.min(water * 6, 1);
  const edge = dry * gradient / (water + EDGE_WATER_FLOOR);
  return Math.min(DEPOSIT_WET + DEPOSIT_DRY * dry * dry + EDGE_DEPOSIT * edge, EDGE_RATE_MAX);
}

/** 流れが向かう縁。0: 左, 1: 右, 2: 上, 3: 下。GPU 版の applyOperations と同じ番号。 */
export type FlowSinkEdge = 0 | 1 | 2 | 3;

/** 流れの速度から、水と墨を吸い取る下流の縁を決める。大きい成分の向きを取る。 */
export function flowSinkEdge(vx: number, vy: number): FlowSinkEdge {
  if (Math.abs(vx) >= Math.abs(vy)) return vx < 0 ? 0 : 1;
  return vy < 0 ? 2 : 3;
}

export class FluidSolver {
  public grid: FluidGrid;
  public wet: number = 0;
  /** 顔料の定着率の倍率。流し書きの間は FlowController が下げ、墨を浮かせたまま運ぶ。 */
  public depositScale: number = 1;

  constructor(grid: FluidGrid) {
    this.grid = grid;
  }

  public get isGpu(): boolean {
    return false;
  }

  public resize(width: number, height: number): void {
    this.grid.resize(width, height);
    this.wet = 0;
  }

  /** CPU/GPUの正本を同期し、作品を失わずに新しい表示領域へ移す。 */
  public async resizePreservingState(
    width: number,
    height: number,
    options: PreservingResizeOptions = {},
  ): Promise<boolean> {
    if (width === this.grid.W && height === this.grid.H) return false;

    const readback = this.readback();
    if (readback) await readback;
    if (options.shouldApply && !options.shouldApply()) return false;

    options.beforeResize?.();
    const state = this.grid.captureState();

    this.resize(width, height);
    this.grid.restoreFittedState(state);
    this.wet = this.grid.w.some((water) => water > CAP) ? 1 : 0;
    this.uploadFromGrid();
    return true;
  }

  public runSteps(count: number): void {
    for (let step = 0; step < count; step++) this.simStep();
  }

  /** GPU実装との共通境界。CPU版では配列が常に正本なので同期は不要。 */
  public readback(): Promise<void> | null {
    return null;
  }

  /** CPU配列の内容を実行状態へ反映する。 */
  public uploadFromGrid(): void {}

  public clearAll(): void {
    this.grid.clearAll();
    this.wet = 0;
  }

  // 1. 毛細管拡散・蒸発・顔料定着
  public simStep(): void {
    const { gw, gh, N, w, w2, u, v, perm, p, p2, d, fiberCos2, fiberSin2 } = this.grid;
    w2.set(w);
    p2[0].set(p[0]);
    p2[1].set(p[1]);
    p2[2].set(p[2]);
    this.wet = 0;

    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      const hasUp = y > 0, hasDown = y < gh - 1;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        const wi = w[i] ?? 0;
        if (wi <= CAP) continue;
        this.wet++;
        const inv = 1 / wi;
        const hasLeft = x > 0, hasRight = x < gw - 1;

        // 8近傍への毛細管拡散。重みは NEIGHBOR_DX / NEIGHBOR_DY と同じ順で、
        // 繊維に沿う向きほど大きくなる（fiberWeight 参照）。
        for (let n = 0; n < 8; n++) {
          const dx = NEIGHBOR_DX[n]!, dy = NEIGHBOR_DY[n]!;
          if ((dx < 0 && !hasLeft) || (dx > 0 && !hasRight)) continue;
          if ((dy < 0 && !hasUp) || (dy > 0 && !hasDown)) continue;
          const j = i + dx + dy * gw;

          const wj = w[j] ?? 0;
          const dw = wi - wj;
          if (dw <= 0) continue;

          const weight = fiberWeight(n, fiberCos2[j] ?? 0, fiberSin2[j] ?? 0);
          const permJ = perm[j] ?? 1;
          const f = Math.min(
            DIFF * permJ * dw * (0.6 + Math.random() * 0.8) * weight,
            wi * 0.18 * weight,
          );
          w2[j]! += f;
          w2[i]! -= f;

          const fr = f * inv;
          for (let c = 0; c < 3; c++) {
            const pc = p[c as ColorIndex];
            const p2c = p2[c as ColorIndex];
            const pci = pc[i] ?? 0;
            if (pci <= 0) continue;
            const move = fr * pci;
            p2c[j]! += move;
            p2c[i]! -= move;
          }
        }
      }
    }

    for (let i = 0; i < N; i++) {
      let wi = (w2[i] ?? 0) * EVAP;
      if (wi < 0.0008) wi = 0;
      const p0 = p2[0][i] ?? 0, p1 = p2[1][i] ?? 0, p2v = p2[2][i] ?? 0;
      if (p0 + p1 + p2v < PIGMENT_EPSILON) {
        // 定着は指数減衰で 0 に届かないため、見えない量になったら打ち切って
        // 以後のセルを勾配計算の対象から外す。
        p[0][i] = 0;
        p[1][i] = 0;
        p[2][i] = 0;
      } else {
        const rate = depositionRate(wi, waterGradient(w, i, gw, gh)) * this.depositScale;
        for (let c = 0; c < 3; c++) {
          const dc = d[c as ColorIndex];
          const pc = p[c as ColorIndex];
          const pv = p2[c as ColorIndex][i] ?? 0;
          if (pv > 0) {
            const dep = pv * rate;
            dc[i] = (dc[i] ?? 0) + dep;
            pc[i] = pv - dep;
          } else {
            pc[i] = pv;
          }
        }
      }
      w[i] = wi;
      u[i]! *= VDAMP;
      v[i]! *= VDAMP;
    }
  }

  // 2. セミ・ラグランジュ移流
  public advect(): void {
    const { gw, gh, w, w2, u, v, ambU, ambV, p, p2 } = this.grid;
    w2.set(w);
    p2[0].set(p[0]);
    p2[1].set(p[1]);
    p2[2].set(p[2]);

    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        const wi = w[i] ?? 0;
        const g = Math.min(wi * 3.5, 1);
        if (g < 0.02) continue;

        const ui = u[i] ?? 0, vi = v[i] ?? 0;
        const ambUi = ambU[i] ?? 0, ambVi = ambV[i] ?? 0;

        const vx = (ui + ambUi) * g;
        const vy = (vi + ambVi) * g;
        if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
          u[i] = 0;
          v[i] = 0;
          continue;
        }
        if (vx * vx + vy * vy < 1e-6) continue;

        const sx = Math.max(0, Math.min(gw - 1.001, x - vx));
        const sy2 = Math.max(0, Math.min(gh - 1.001, y - vy));
        const x0 = sx | 0, y0 = sy2 | 0;
        const fx = sx - x0, fy = sy2 - y0;
        const j00 = y0 * gw + x0, j10 = j00 + 1, j01 = j00 + gw, j11 = j01 + 1;
        const a00 = (1 - fx) * (1 - fy), a10 = fx * (1 - fy), a01 = (1 - fx) * fy, a11 = fx * fy;

        const w00 = w[j00] ?? 0, w10 = w[j10] ?? 0, w01 = w[j01] ?? 0, w11 = w[j11] ?? 0;
        const bl_w = w00 * a00 + w10 * a10 + w01 * a01 + w11 * a11;
        w2[i] = wi + (bl_w - wi) * g;

        for (let c = 0; c < 3; c++) {
          const pc = p[c as ColorIndex];
          const p2c = p2[c as ColorIndex];

          const p00 = pc[j00] ?? 0, p10 = pc[j10] ?? 0, p01 = pc[j01] ?? 0, p11 = pc[j11] ?? 0;
          const bl_p = p00 * a00 + p10 * a10 + p01 * a01 + p11 * a11;
          const pci = pc[i] ?? 0;
          p2c[i] = pci + (bl_p - pci) * g;
        }
      }
    }

    [this.grid.w, this.grid.w2] = [this.grid.w2, this.grid.w];
    for (let c = 0; c < 3; c++) {
      const idx = c as ColorIndex;
      [this.grid.p[idx], this.grid.p2[idx]] = [this.grid.p2[idx], this.grid.p[idx]];
    }
  }

  // 3. 水分・顔料の投入。別々に指定することで滲みと墨の濃淡を表現する。
  public deposit(
    cx: number,
    cy: number,
    waterAmount: number,
    pigmentAmount: number,
    radius: number,
    curColor: ColorIndex,
  ): void {
    this.grid.includeArea(cx, cy, radius * this.grid.CS);
    const r2 = radius * radius;
    const pc = this.grid.p[curColor];

    this.grid.gridArea(cx, cy, radius, (i, _dx, _dy, q2) => {
      const fall = Math.exp(-q2 / (r2 * 0.35));
      const wi = this.grid.w[i] ?? 0;
      const pci = pc[i] ?? 0;
      this.grid.w[i] = Math.min(wi + waterAmount * fall, 2.4);
      pc[i] = Math.min(pci + pigmentAmount * fall, 1.5);
    });
  }

  // 4. 運動量・速度の付与
  public addVel(cx: number, cy: number, vx: number, vy: number, radius: number): void {
    const r2 = radius * radius;
    this.grid.gridArea(cx, cy, radius, (i, _dx, _dy, q2) => {
      const fall = Math.exp(-q2 / (r2 * 0.4));
      if (this.grid.u[i] !== undefined) this.grid.u[i] += vx * fall;
      if (this.grid.v[i] !== undefined) this.grid.v[i] += vy * fall;
    });
  }

  /** 水洗いの1フレーム。GPU版でも同じ呼び出し境界を使用する。 */
  public rinseStep(t: number, sweepFrames: number, totalFrames: number): void {
    this.grid.includeViewport();
    const { gh, gw, w, v, u, ambU, d, p, N } = this.grid;
    const frontRow = Math.min(gh, ((gh * t / sweepFrames) | 0) + 2);
    const pouring = t < totalFrames - 100;

    for (let y = 0; y < frontRow; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        const wi = w[i] ?? 0;
        if (pouring && wi < 2.2) w[i] = wi + 0.13;
        if ((v[i] ?? 0) < 1.4) v[i]! += 0.13;
        u[i]! += (Math.random() - 0.5) * 0.07 + (ambU[i] ?? 0) * 0.5;

        const dissolve = Math.min(w[i] ?? 0, 1.2) * 0.05;
        for (let c = 0; c < 3; c++) {
          const index = c as ColorIndex;
          const moved = (d[index][i] ?? 0) * dissolve;
          d[index][i]! -= moved;
          p[index][i]! += moved;
        }
      }
    }

    for (let y = Math.max(0, gh - 3); y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        w[i]! *= 0.55;
        for (let c = 0; c < 3; c++) {
          const index = c as ColorIndex;
          p[index][i]! *= 0.5;
          d[index][i]! *= 0.9;
        }
      }
    }

    if (!pouring) {
      for (let i = 0; i < N; i++) {
        w[i]! *= 0.95;
        for (let c = 0; c < 3; c++) {
          const index = c as ColorIndex;
          d[index][i]! *= 0.94;
          p[index][i]! *= 0.94;
        }
      }
    }
    this.wet = 1;
  }

  /**
   * 流し書きの 1 フレーム。
   * - 水を waterFloor まで張り（入の間）、dryFactor 倍に引かせる（切にした後）。
   * - 濡れているセルの速度を (vx, vy) へ寄せる。
   * - 水を張っている間は、下流の縁で水と浮遊顔料を吸い取る。
   * 定着した墨には触れないので、乾いた作品はその場に残り、浮いている墨だけが流れる。
   */
  public flowStep(vx: number, vy: number, waterFloor: number, dryFactor: number): void {
    this.grid.includeViewport();
    const { gw, gh, N, w, u, v, p } = this.grid;
    const speed = Math.hypot(vx, vy);
    const perpX = speed > 0 ? -vy / speed : 0;
    const perpY = speed > 0 ? vx / speed : 0;
    for (let i = 0; i < N; i++) {
      let wi = Math.max(w[i] ?? 0, waterFloor) * dryFactor;
      if (wi < 0.0008) wi = 0;
      w[i] = wi;
      if (wi <= CAP) continue;
      const jitter = (Math.random() - 0.5) * FLOW_JITTER;
      u[i]! += (vx - (u[i] ?? 0)) * FLOW_RELAX + perpX * jitter;
      v[i]! += (vy - (v[i] ?? 0)) * FLOW_RELAX + perpY * jitter;
    }
    if (waterFloor <= 0) return;

    const edge = flowSinkEdge(vx, vy);
    const sink = Math.min(FLOW_SINK_CELLS, gw, gh);
    const drain = (i: number): void => {
      w[i]! *= FLOW_SINK_WATER;
      for (let c = 0; c < 3; c++) p[c as ColorIndex][i]! *= FLOW_SINK_PIGMENT;
    };
    if (edge === 0 || edge === 1) {
      const x0 = edge === 0 ? 0 : gw - sink;
      for (let y = 0; y < gh; y++) {
        for (let x = x0; x < x0 + sink; x++) drain(y * gw + x);
      }
    } else {
      const y0 = edge === 2 ? 0 : gh - sink;
      for (let y = y0; y < y0 + sink; y++) {
        for (let x = 0; x < gw; x++) drain(y * gw + x);
      }
    }
  }

  // 5. 渦運動の付与
  public swirl(cx: number, cy: number): void {
    const R = 27 / this.grid.CS, dir = Math.random() < 0.5 ? 1 : -1;
    this.grid.gridArea(cx, cy, R, (i, dx, dy, q2) => {
      const q = Math.sqrt(q2);
      if (q < 0.5) return;
      const s = (dir * 0.9 * Math.exp(-q2 / (R * R * 0.3))) / q;
      if (this.grid.u[i] !== undefined) this.grid.u[i] += -dy * s;
      if (this.grid.v[i] !== undefined) this.grid.v[i] += dx * s;
    });
  }
}
