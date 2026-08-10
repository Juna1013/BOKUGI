import { CS, AMB } from '../config.ts';
import { makeNoise } from './Noise.ts';
import type { GridAreaCallback } from '../types/physics.ts';

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

  constructor(W: number, H: number) {
    this.CS = CS;
    this.resize(W, H);
  }

  public resize(W: number, H: number): void {
    this.W = W;
    this.H = H;
    this.gw = Math.ceil(W / CS);
    this.gh = Math.ceil(H / CS);
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
      const pc = this.p[c as 0 | 1 | 2];
      const dc = this.d[c as 0 | 1 | 2];
      if (pc) pc.fill(0);
      if (dc) dc.fill(0);
    }
  }
}
