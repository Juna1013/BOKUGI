import { CS, AMB } from '../config.ts';
import { makeNoise } from './Noise.ts';
import type { ColorIndex, GridAreaCallback } from '../types/physics.ts';

export interface FluidGridState {
  viewportWidth: number;
  viewportHeight: number;
  cellSize: number;
  columns: number;
  rows: number;
  water: Float32Array;
  velocityX: Float32Array;
  velocityY: Float32Array;
  mobilePigment: [Float32Array, Float32Array, Float32Array];
  fixedPigment: [Float32Array, Float32Array, Float32Array];
}

export class FluidGrid {
  public CS: number;
  public W!: number;
  public H!: number;
  public gw!: number;
  public gh!: number;
  public N!: number;

  public w!: Float32Array;
  public w2!: Float32Array;
  public u!: Float32Array;
  public v!: Float32Array;
  public ambU!: Float32Array;
  public ambV!: Float32Array;
  public perm!: Float32Array;
  public grain!: Float32Array;

  public p!: [Float32Array, Float32Array, Float32Array];
  public p2!: [Float32Array, Float32Array, Float32Array];
  public d!: [Float32Array, Float32Array, Float32Array];

  constructor(W: number, H: number, cellSize: number = CS) {
    this.CS = cellSize;
    this.resize(W, H);
  }

  public resize(W: number, H: number): void {
    this.W = W;
    this.H = H;
    this.gw = Math.ceil(W / this.CS);
    this.gh = Math.ceil(H / this.CS);
    this.N = this.gw * this.gh;

    this.w = new Float32Array(this.N);
    this.w2 = new Float32Array(this.N);
    this.u = new Float32Array(this.N);
    this.v = new Float32Array(this.N);
    this.ambU = new Float32Array(this.N);
    this.ambV = new Float32Array(this.N);
    this.perm = new Float32Array(this.N);
    this.grain = new Float32Array(this.N);

    this.p = [new Float32Array(this.N), new Float32Array(this.N), new Float32Array(this.N)];
    this.p2 = [new Float32Array(this.N), new Float32Array(this.N), new Float32Array(this.N)];
    this.d = [new Float32Array(this.N), new Float32Array(this.N), new Float32Array(this.N)];

    this.buildFields();
  }

  private buildFields(): void {
    const { gw, gh, perm, grain, ambU, ambV } = this;
    const n1 = makeNoise(24, 60), s1x = 24 / gw, s1y = 60 / gh;
    const n2 = makeNoise(70, 160), s2x = 70 / gw, s2y = 160 / gh;
    const n3 = makeNoise(200, 400), s3x = 200 / gw, s3y = 400 / gh;

    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const val = n1(x * s1x, y * s1y) * 0.45 + n2(x * s2x, y * s2y) * 0.35 + n3(x * s3x, y * s3y) * 0.20;
        perm[i] = Math.min(1.4, Math.pow(val, 1.6) * 1.9 + 0.12);
        grain[i] = 0.82 + Math.random() * 0.36;
      }
    }

    const nf = makeNoise(14, 14), sx = 14 / gw, sy = 14 / gh, eps = 1.5;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const i = y * gw + x;
        const dndy = nf(x * sx, (y + eps) * sy) - nf(x * sx, Math.max(0, y - eps) * sy);
        const dndx = nf((x + eps) * sx, y * sy) - nf(Math.max(0, x - eps) * sx, y * sy);
        ambU[i] = (dndy * AMB) / eps;
        ambV[i] = (-dndx * AMB) / eps;
      }
    }
  }

  public gridArea(cx: number, cy: number, R: number, fn: GridAreaCallback): void {
    const { CS, gw, gh } = this;
    const gx = cx / CS, gy = cy / CS, r2 = R * R;
    const x0 = Math.max(0, (gx - R) | 0), x1 = Math.min(gw - 1, Math.ceil(gx + R));
    const y0 = Math.max(0, (gy - R) | 0), y1 = Math.min(gh - 1, Math.ceil(gy + R));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - gx, dy = y - gy, q2 = dx * dx + dy * dy;
        if (q2 <= r2) fn(y * gw + x, dx, dy, q2);
      }
    }
  }

  public clearAll(): void {
    this.w.fill(0);
    this.u.fill(0);
    this.v.fill(0);
    for (let c = 0; c < 3; c++) {
      this.p[c as ColorIndex].fill(0);
      this.d[c as ColorIndex].fill(0);
    }
  }

  /** 現在の動的な流体状態を、格子の寿命から切り離して保持する。 */
  public captureState(): FluidGridState {
    return {
      viewportWidth: this.W,
      viewportHeight: this.H,
      cellSize: this.CS,
      columns: this.gw,
      rows: this.gh,
      water: this.w.slice(),
      velocityX: this.u.slice(),
      velocityY: this.v.slice(),
      mobilePigment: [this.p[0].slice(), this.p[1].slice(), this.p[2].slice()],
      fixedPigment: [this.d[0].slice(), this.d[1].slice(), this.d[2].slice()],
    };
  }

  /**
   * 旧状態の縦横比を保ったまま中央へ収め、新しい格子へ再サンプリングする。
   * 余白は白紙のままにするため、回転時にも作品全体が切れない。
   */
  public restoreFittedState(state: FluidGridState): void {
    if (
      state.viewportWidth <= 0 ||
      state.viewportHeight <= 0 ||
      state.cellSize <= 0 ||
      state.columns <= 0 ||
      state.rows <= 0
    ) return;

    const scale = Math.min(
      this.W / state.viewportWidth,
      this.H / state.viewportHeight,
    );
    const offsetX = (this.W - state.viewportWidth * scale) / 2;
    const offsetY = (this.H - state.viewportHeight * scale) / 2;

    for (let y = 0; y < this.gh; y++) {
      const targetY = (y + 0.5) * this.CS;
      const sourceY = (targetY - offsetY) / scale;
      if (sourceY < 0 || sourceY > state.viewportHeight) continue;

      const gridY = Math.max(
        0,
        Math.min(state.rows - 1, sourceY / state.cellSize - 0.5),
      );
      const y0 = Math.floor(gridY);
      const y1 = Math.min(state.rows - 1, y0 + 1);
      const fy = gridY - y0;

      for (let x = 0; x < this.gw; x++) {
        const targetX = (x + 0.5) * this.CS;
        const sourceX = (targetX - offsetX) / scale;
        if (sourceX < 0 || sourceX > state.viewportWidth) continue;

        const gridX = Math.max(
          0,
          Math.min(state.columns - 1, sourceX / state.cellSize - 0.5),
        );
        const x0 = Math.floor(gridX);
        const x1 = Math.min(state.columns - 1, x0 + 1);
        const fx = gridX - x0;
        const targetIndex = y * this.gw + x;
        const topLeft = y0 * state.columns + x0;
        const topRight = y0 * state.columns + x1;
        const bottomLeft = y1 * state.columns + x0;
        const bottomRight = y1 * state.columns + x1;

        this.w[targetIndex] = this.sampleBilinear(
          state.water,
          topLeft,
          topRight,
          bottomLeft,
          bottomRight,
          fx,
          fy,
        );
        this.u[targetIndex] = this.sampleBilinear(
          state.velocityX,
          topLeft,
          topRight,
          bottomLeft,
          bottomRight,
          fx,
          fy,
        ) * scale;
        this.v[targetIndex] = this.sampleBilinear(
          state.velocityY,
          topLeft,
          topRight,
          bottomLeft,
          bottomRight,
          fx,
          fy,
        ) * scale;

        for (let color = 0; color < 3; color++) {
          const index = color as ColorIndex;
          this.p[index][targetIndex] = this.sampleBilinear(
            state.mobilePigment[index],
            topLeft,
            topRight,
            bottomLeft,
            bottomRight,
            fx,
            fy,
          );
          this.d[index][targetIndex] = this.sampleBilinear(
            state.fixedPigment[index],
            topLeft,
            topRight,
            bottomLeft,
            bottomRight,
            fx,
            fy,
          );
        }
      }
    }

    this.w2.set(this.w);
    for (let color = 0; color < 3; color++) {
      const index = color as ColorIndex;
      this.p2[index].set(this.p[index]);
    }
  }

  private sampleBilinear(
    source: Float32Array,
    topLeft: number,
    topRight: number,
    bottomLeft: number,
    bottomRight: number,
    fx: number,
    fy: number,
  ): number {
    const top = (source[topLeft] ?? 0) * (1 - fx) + (source[topRight] ?? 0) * fx;
    const bottom =
      (source[bottomLeft] ?? 0) * (1 - fx) + (source[bottomRight] ?? 0) * fx;
    return top * (1 - fy) + bottom * fy;
  }
}
