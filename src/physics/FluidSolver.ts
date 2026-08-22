import { DIFF, CAP, EVAP, VDAMP } from '../config.ts';
import type { FluidGrid } from './FluidGrid.ts';
import type { ColorIndex } from '../types/physics.ts';

export interface PreservingResizeOptions {
  /** GPU readback中に要求が古くなった場合、格子を書き換える直前で中止する。 */
  shouldApply?: () => boolean;
  /** 旧格子の履歴など、再サンプリング前に解放できるメモリを破棄する。 */
  beforeResize?: () => void;
}

export class FluidSolver {
  public grid: FluidGrid;
  public wet: number = 0;

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

  /** Undo/Redoで復元されたCPU配列を実行状態へ反映する。 */
  public uploadFromGrid(): void {}

  public clearAll(): void {
    this.grid.clearAll();
    this.wet = 0;
  }

  // 1. 毛細管拡散・蒸発・顔料定着
  public simStep(): void {
    const { gw, gh, N, w, w2, u, v, perm, p, p2, d } = this.grid;
    w2.set(w);
    p2[0].set(p[0]);
    p2[1].set(p[1]);
    p2[2].set(p[2]);
    this.wet = 0;

    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const i = row + x;
        const wi = w[i] ?? 0;
        if (wi <= CAP) continue;
        this.wet++;
        const inv = 1 / wi;

        // 4近傍への毛細管拡散。上下左右で処理は同一のため、隣接セルの
        // 添字だけを差し替えて回す。
        for (let n = 0; n < 4; n++) {
          let j: number;
          if (n === 0) { if (x <= 0) continue; j = i - 1; }
          else if (n === 1) { if (x >= gw - 1) continue; j = i + 1; }
          else if (n === 2) { if (y <= 0) continue; j = i - gw; }
          else { if (y >= gh - 1) continue; j = i + gw; }

          const wj = w[j] ?? 0;
          const dw = wi - wj;
          if (dw <= 0) continue;

          const permJ = perm[j] ?? 1;
          const f = Math.min(DIFF * permJ * dw * (0.6 + Math.random() * 0.8), wi * 0.18);
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
      const dry = 1 - Math.min(wi * 6, 1);
      const rate = 0.003 + 0.05 * dry * dry;
      for (let c = 0; c < 3; c++) {
        const p2c = p2[c as ColorIndex];
        const dc = d[c as ColorIndex];
        const pc = p[c as ColorIndex];

        const pv = p2c[i] ?? 0;
        if (pv > 0) {
          const dep = pv * rate;
          dc[i] = (dc[i] ?? 0) + dep;
          pc[i] = pv - dep;
        } else {
          pc[i] = pv;
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

  // 3. 水分・顔料の投入。別々に指定することで水筆と墨の濃淡を表現する。
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
